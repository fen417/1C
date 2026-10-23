import { DurableObject } from 'cloudflare:workers';

const MAX_SCORE = 26_000_000;
const MAX_SECONDS = 86_400;
const RUN_START_INTERVAL_MS = 1_000;
const FINISH_INTERVAL_MS = 10_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

async function hashIp(ip) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '').slice(0, 15);
}

function cleanLoadout(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function validMode(mode) {
  return ['solo', 'pvp', 'pve', 'battle_royale'].includes(mode);
}

function validVersion(version) {
  return typeof version === 'string' && /^[0-9A-Za-z._-]{1,16}$/.test(version);
}

function validResult(score, seconds) {
  return Number.isSafeInteger(score) && Number.isSafeInteger(seconds) &&
    score >= 0 && score <= MAX_SCORE && seconds >= 0 && seconds <= MAX_SECONDS;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function beginRun(request, env) {
  const body = await readJson(request);
  const mode = body?.mode;
  const version = body?.version;
  const players = Number(body?.players ?? (mode === 'solo' ? 1 : 2));
  if (!validMode(mode) || !validVersion(version) || !Number.isInteger(players) || players < (mode === 'solo' ? 1 : 2) || players > 8 || (mode === 'solo' && players !== 1)) return json({ error: 'Некорректные параметры забега.' }, 400);

  const ipHash = await hashIp(request.headers.get('cf-connecting-ip') || 'unknown');
  const now = Date.now();
  try {
    await env.DB.prepare('DELETE FROM run_sessions WHERE started_at < ?').bind(now - 7 * 24 * 60 * 60 * 1000).run();
    const gate = await env.DB.prepare(
      'INSERT INTO run_start_limits (ip_hash, last_started_at) VALUES (?, ?) ON CONFLICT(ip_hash) DO UPDATE SET last_started_at = excluded.last_started_at WHERE run_start_limits.last_started_at <= ? RETURNING ip_hash'
    ).bind(ipHash, now, now - RUN_START_INTERVAL_MS).first();
    if (!gate) return json({ error: 'Подождите перед запуском следующего проверяемого забега.' }, 429);

    const runId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO run_sessions (run_id, started_at, version, mode, player_count, status) VALUES (?, ?, ?, ?, ?, 'active')"
    ).bind(runId, now, version, mode, players).run();
    return json({ runId, startedAt: now, checkpointInterval: 10 });
  } catch {
    return json({ error: 'Не удалось зарегистрировать забег.' }, 503);
  }
}

async function saveCheckpoint(request, env) {
  const body = await readJson(request);
  const runId = typeof body?.runId === 'string' ? body.runId : '';
  const sequence = Number(body?.sequence);
  // Older game builds still send a checkpoint every few seconds. Acknowledge it
  // without a D1 read/write so those clients keep working while avoiding load.
  if (!runId || !Number.isSafeInteger(sequence) || sequence < 1) return json({ error: 'Некорректная контрольная точка.' }, 400);
  return json({ ok: true, sequence });
}

async function applySubmitLimit(request, env, now) {
  const ipHash = await hashIp(request.headers.get('cf-connecting-ip') || 'unknown');
  const gate = await env.DB.prepare(
    'INSERT INTO submit_limits (ip_hash, last_submit_at) VALUES (?, ?) ON CONFLICT(ip_hash) DO UPDATE SET last_submit_at = excluded.last_submit_at WHERE submit_limits.last_submit_at <= ? RETURNING ip_hash'
  ).bind(ipHash, now, now - FINISH_INTERVAL_MS).first();
  return Boolean(gate);
}

async function submitRecord(request, env) {
  const body = await readJson(request);
  const name = cleanName(body?.name);
  const score = Number(body?.score);
  const seconds = Number(body?.seconds);
  const mode = body?.mode;
  const version = body?.version;
  const players = Number(body?.players ?? (mode === 'solo' ? 1 : 2));
  const loadout = cleanLoadout(body?.loadout);
  const allowedClasses = new Set(['technician', 'courier', 'developer', 'support']);
  const classId = allowedClasses.has(body?.classId) ? body.classId : null;
  if (!name || !validResult(score, seconds) || !validMode(mode) || !validVersion(version) ||
      !Number.isInteger(players) || players < (mode === 'solo' ? 1 : 2) || players > 8 ||
      (mode === 'solo' && players !== 1)) {
    return json({ error: 'Некорректные данные рекорда.' }, 400);
  }

  const now = Date.now();
  try {
    if (!(await applySubmitLimit(request, env, now))) return json({ error: 'Подождите несколько секунд перед следующей отправкой рекорда.' }, 429);
    await env.DB.prepare(
      'INSERT INTO leaderboard (id, name, score, seconds, version, mode, player_count, class_id, loadout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), name, score, seconds, version, mode, players, classId, loadout, now).run();
    return json({ ok: true });
  } catch {
    return json({ error: 'Не удалось сохранить рекорд.' }, 503);
  }
}

async function finishRun(request, env) {
  const body = await readJson(request);
  const runId = typeof body?.runId === 'string' ? body.runId : '';
  const name = cleanName(body?.name);
  const score = Number(body?.score);
  const seconds = Number(body?.seconds);
  const loadout = cleanLoadout(body?.loadout);
  const allowedClasses = new Set(['technician', 'courier', 'developer', 'support']);
  const classId = allowedClasses.has(body?.classId) ? body.classId : null;
  if (!runId || !name || !validResult(score, seconds)) return json({ error: 'Некорректные данные итога забега.' }, 400);

  const now = Date.now();
  try {
    const session = await env.DB.prepare(
      "SELECT run_id, version, mode, player_count, status FROM run_sessions WHERE run_id = ?"
    ).bind(runId).first();
    if (!session || session.status !== 'active') return json({ error: 'Проверяемый забег не найден или уже завершён.' }, 404);
    if (!(await applySubmitLimit(request, env, now))) return json({ error: 'Подождите несколько секунд перед следующей отправкой рекорда.' }, 429);

    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE run_sessions SET status = 'completed', last_seconds = ?, last_score = ?, final_name = ?, final_loadout = ? WHERE run_id = ? AND status = 'active' RETURNING run_id"
      ).bind(seconds, score, name, loadout, runId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO leaderboard (id, name, score, seconds, version, mode, player_count, class_id, loadout, created_at) SELECT run_id, final_name, last_score, last_seconds, version, mode, player_count, ?, final_loadout, ? FROM run_sessions WHERE run_id = ? AND status = 'completed'"
      ).bind(classId, now, runId)
    ]);
    if (!results[0]?.results?.length) return json({ error: 'Забег уже обработан. Обновите таблицу.' }, 409);
    return json({ ok: true });
  } catch {
    return json({ error: 'Не удалось завершить проверку и сохранить результат.' }, 503);
  }
}

// Optional diagnostic endpoint for measuring the route to Cloudflare's edge.
export class LatencyProbe extends DurableObject {
  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    try {
      const payload = JSON.parse(message);
      if (payload?.type !== 'ping' || typeof payload.id !== 'string') return;
      socket.send(JSON.stringify({ type: 'pong', id: payload.id, serverTime: Date.now() }));
    } catch {
      // Ignore malformed probe messages.
    }
  }
}

function latencyTestPage(edge) {
  const edgeLabel = typeof edge === 'string' ? edge : 'не определён';
  return `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка задержки игровой комнаты</title>
<style>
  body{font:16px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
  button{font:inherit;padding:10px 16px;cursor:pointer} .box{background:#f3f3f3;padding:16px;margin-top:16px;border-radius:8px}
  #status{font-weight:600} #log{white-space:pre-wrap;font:13px monospace;max-height:280px;overflow:auto}
</style>
<h1>Проверка задержки</h1>
<p>Проверяет WebSocket до Durable Object. Запустите на обоих компьютерах в одной сети.</p>
<p>Cloudflare edge: <b>${edgeLabel}</b></p>
<button id="start">Начать замер (30 секунд)</button>
<button id="stop" disabled>Остановить</button>
<div class="box">
  <div id="status">Ожидание</div>
  <p>Последний RTT: <b id="last">—</b><br>Средний: <b id="average">—</b><br>Медианный: <b id="median">—</b><br>95-й перцентиль: <b id="p95">—</b><br>Ответов: <b id="count">0</b></p>
  <pre id="log"></pre>
</div>
<script>
(() => {
  const $ = id => document.getElementById(id);
  let socket = null, timer = null, startedAt = 0, seq = 0, pending = new Map(), samples = [];
  const fmt = value => value == null ? '—' : value.toFixed(1) + ' мс';
  function refresh() {
    const sorted = [...samples].sort((a,b) => a-b);
    const avg = samples.length ? samples.reduce((a,b) => a+b,0) / samples.length : null;
    $('count').textContent = String(samples.length);
    $('average').textContent = fmt(avg);
    $('median').textContent = fmt(sorted.length ? sorted[Math.floor((sorted.length-1)*0.5)] : null);
    $('p95').textContent = fmt(sorted.length ? sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*0.95)-1)] : null);
  }
  function stop(message) {
    clearInterval(timer); timer = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    $('start').disabled = false; $('stop').disabled = true;
    $('status').textContent = message;
  }
  $('start').onclick = () => {
    samples = []; pending.clear(); seq = 0; startedAt = performance.now(); $('log').textContent = '';
    const address = new URL('/ws/latency', location.href);
    address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    $('status').textContent = 'Подключение…'; $('start').disabled = true; $('stop').disabled = false;
    socket = new WebSocket(address);
    socket.onopen = () => {
      $('status').textContent = 'Соединено, идёт замер…';
      const sendPing = () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const id = String(++seq), sentAt = performance.now(); pending.set(id, sentAt);
        socket.send(JSON.stringify({type:'ping', id}));
      };
      sendPing(); timer = setInterval(() => {
        if (performance.now() - startedAt >= 30000) { stop('Замер завершён'); return; }
        sendPing();
      }, 1000);
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data), sentAt = pending.get(message.id);
        if (message.type !== 'pong' || sentAt == null) return;
        pending.delete(message.id);
        const rtt = performance.now() - sentAt; samples.push(rtt);
        $('last').textContent = fmt(rtt); refresh();
        $('log').textContent += '#' + message.id + '  ' + fmt(rtt) + '\\n';
        $('log').scrollTop = $('log').scrollHeight;
      } catch {}
    };
    socket.onerror = () => { $('status').textContent = 'Ошибка WebSocket'; };
    socket.onclose = () => {
      if (timer) { clearInterval(timer); timer = null; }
      $('start').disabled = false; $('stop').disabled = true;
      if (samples.length) $('status').textContent = 'Соединение закрыто; замер сохранён на экране';
      else $('status').textContent = 'Не удалось подключиться';
    };
  };
  $('stop').onclick = () => stop('Замер остановлен');
})();
</script>
</html>`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return optionsResponse();
    const url = new URL(request.url);

    if (url.pathname === '/latency-test') {
      return new Response(latencyTestPage(request.cf?.colo), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    if (url.pathname === '/ws/latency') {
      const id = env.LATENCY_PROBE.idFromName('shared-latency-probe');
      return env.LATENCY_PROBE.get(id).fetch(request);
    }

    if (url.pathname === '/leaderboard') {
      if (request.method !== 'GET') return json({ error: 'Для записи нужен проверяемый забег.' }, 405);
      try {
        const { results } = await env.DB.prepare(
          'SELECT name, score, seconds, version, mode, player_count AS playerCount, class_id AS classId, loadout, created_at AS createdAt FROM leaderboard ORDER BY score DESC, seconds ASC, created_at ASC LIMIT 100'
        ).all();
        return json({ scores: results });
      } catch {
        return json({ error: 'Не удалось загрузить таблицу рекордов.' }, 503);
      }
    }

    if (request.method !== 'POST') return json({ error: 'Метод не поддерживается.' }, 405);
    if (url.pathname === '/run/start') return beginRun(request, env);
    if (url.pathname === '/run/checkpoint') return saveCheckpoint(request, env);
    if (url.pathname === '/run/finish') return finishRun(request, env);
    if (url.pathname === '/record') return submitRecord(request, env);
    return json({ error: 'Маршрут не найден.' }, 404);
  }
};
