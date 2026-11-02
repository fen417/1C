# 1С:Фитнес Клуб КОРП

Browser game with its interface and logic in one HTML file and recorded music in
`audio/red-protocol/`.

## Publish

GitHub Pages is deployed automatically on every push to `main` and can also be
started manually from the Actions tab. The Pages artifact is created from the
game HTML as `index.html`, with the `audio/` directory beside it. Keep this
directory in the published artifact: the music uses relative URLs, including
when the site is hosted under the repository path.

«Красный протокол» has normal, miniboss and big-boss arrangements. It is the
default for solo play and can be selected for other modes in settings. Saved
manual choices are preserved. Sample credits and the CC0 license are included
in `audio/red-protocol/`.

The initial repository setup must enable GitHub Pages with **GitHub Actions**
as its build and deployment source.
