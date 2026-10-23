# Cloudflare leaderboard Worker

`src/index.js` is the editable source retrieved from the deployed `fitness-leaderboard` Worker. The repo did not previously contain the Worker project.

The attached D1 database already contains the base schema and migrations `0002_player_count.sql` and `0003_leaderboard_class.sql`. Migration `0004_leaderboard_loadout.sql` extends that existing database; this folder is not a clean bootstrap for a new database.

The Worker uses the existing `DB` D1 binding and `LATENCY_PROBE` Durable Object. No Cloudflare credentials or runtime secrets are stored here.
