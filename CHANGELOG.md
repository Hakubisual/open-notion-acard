# Changelog

All notable changes to this project. Dates are UTC.

## 0.3.3 - 2026-10-26

### Fixed

- Typing and saving in the editor on your own server (the desktop app or `bun local/main.ts`) no longer depends on a
  hosted sign-in, so a fresh data folder takes text, saves it and shows it again after a reload.
- The built-in server sends its font files, so pages draw in their own fonts instead of falling back to system fonts.
- With the English interface, the home, tables, new databases, the share dialog, import, the `/` menu and the page
  menu no longer show Korean words, and new database columns are named in the interface language.
- Syncing two computers: when both change the same table, the changes from both are kept. The conflict count in
  **My data** is the same on both computers, and a table made on the other computer under the same address arrives
  as a conflict copy instead of replacing yours.

### Changed

- Deleting an account (at the bottom of Settings, on a server with accounts) removes everything it made: pages,
  files, share links and connected agent apps, then the account itself. Its old share links answer "not found".

### Added

- Footnotes: write `[^id]` in text and the page shows a numbered link to the note, with a link back.
- Headings written inside an HTML block appear in the table of contents.

### 한국어 요약

- 고침: 내 서버(데스크톱 앱이나 `bun local/main.ts`)의 편집기에서 글을 쓰고 저장하는 일이 호스팅 로그인과 상관없이 됩니다.
  새 데이터 폴더에서도 글을 쓰고, 저장하고, 새로고침해도 그대로 남습니다.
- 고침: 내장 서버가 글꼴 파일을 보내서 페이지가 시스템 글꼴이 아니라 원래 글꼴로 보입니다.
- 고침: 영어 화면에서 홈, 표, 새 데이터베이스, 공유 창, 가져오기, `/` 메뉴, 페이지 메뉴에 한국어가 남지 않습니다.
- 고침: 두 컴퓨터를 동기화할 때 같은 표를 양쪽에서 고쳐도 양쪽 변경이 모두 남습니다. **내 데이터** 의 충돌 수가 두 컴퓨터에서
  같고, 다른 컴퓨터에서 같은 주소로 만든 표는 내 표를 덮어쓰지 않고 충돌 사본으로 들어옵니다.
- 바뀜: 계정을 지우면(계정을 쓰는 서버의 설정 맨 아래) 그 계정이 만든 페이지, 파일, 공유 링크, 연결한 에이전트 앱이
  모두 지워지고 계정도 지워집니다. 예전 공유 링크는 "찾을 수 없음"으로 답합니다.
- 추가: 각주 - 글에 `[^id]` 를 쓰면 번호 링크와 돌아가기 링크가 생깁니다. HTML 블록 안의 제목도 목차에 들어갑니다.

## 0.3.2 - 2026-10-24

### Fixed

- The block menu that opens on `/` hit a script error in 0.3.1 and could not draw its grouped list. It works again,
  and a test now draws the built menu in a browser.

### Removed

- The last plugin code: the plugin block type in Markdown (such a fence from the hosted app now imports as a code block), the
  plugin frame helpers in the sandbox policy, the plugin entries in the build and the plugin strings in the UI
  dictionaries. This edition has no plugins.

### Added

- More page fonts to pick in Page settings, served from this server (OFL; their licenses are in `LICENSES/`).

## 0.3.1 - 2026-10-24

### Added

- Page, block and text marks for agents: mark a part as locked (an agent never changes it) or as reference (an agent
  reads it, never changes it). MCP and REST writes keep marked blocks as they were and say which ones they kept.
- More components (diagrams, interactive controls, media) and a kit of cover, header and empty-state images.

### Removed

- The plugin UI renderer (`plugin-ui.js`) that 0.3.0 still carried. This edition has no plugins; a plugin block
  saved by the hosted Acard app shows as an unknown block.

### Docs

- Building the desktop app from source installs the root dependencies first, and the macOS build makes one DMG for
  the Mac it runs on.
- `ACARD_LOCAL_API` is listed as on by default in the team server guide, as it is.

## 0.3.0 - 2026-10-24

### Added

- **Acard Local runs on its own.** The desktop app (`Acard-Local-Setup-0.3.0.exe`) now has two choices on its first
  screen: **Use on this computer** starts a built-in local server (data in `%APPDATA%\Acard Local\data`, port 47811 or
  the first free one up to 47830, no account, no password), and **Connect to a team server** works as before. The
  **Server** menu switches between them (`Ctrl/Cmd+Shift+S`). If you saved a server address in v0.2, the app keeps
  connecting to it. The app's language follows the operating system (Korean, Chinese, otherwise English).
- Token-free MCP and REST for agents on your own computer: `http://127.0.0.1:47811/mcp` and `/api/v1`. Set
  `ACARD_LOCAL_API=0` to turn it off.
- `ACARD_AGENT_TOKEN` for team servers: agents reach `/mcp` and `/api/v1` with `Authorization: Bearer <token>`.
  Without it, agents cannot reach them on a password-protected server; a person's password never works for agents.
- The local server serves `/AGENTS.md`, `/llms.txt` and `/api/v1/openapi.json`.

### Removed

- The AI buttons: ask your notes, photo to text and AI shortcuts. Existing photo-text blocks still show.
- The seeded agent rules page. `get_agent_skills` now only reads a page named `agent-skills` if a person wrote one;
  an existing page stays a normal page.
- The project auto-record sidebar and the first-run agent tools.
- The CLI `hooks` and `setup` commands and the agent add-on downloads. The CLI keeps `pull`, `push`, `mcp` and
  `whoami`.
- The cloud account section in "My data". It is off unless `ACARD_CLOUD_URL` is set.

### Docs

- Two install paths: [for yourself](docs/install-user.md) (one computer, the desktop app) and
  [for a team](docs/install-server.md) (one server; members [join it](docs/install-client.md)).
- README in all three languages: new "Connect your AI agent" section for local and team servers.

## v0.2.0 - 2026-10-23

### Renamed: OpenNotion is now Acard

- The project is now **Acard**, "the open Notion you can run locally". The repository moved from
  `Hakubisual/open-notion` to `Hakubisual/open-notion-acard`; GitHub redirects the old address, so existing clones
  keep working with `git pull`.
- New logo, favicon and app icons (the Acard mark), and the web app now shows the Acard name.
- The desktop client is now **Acard Local** (`Acard-Local-Setup-0.2.0.exe`, app id `dev.acard.local`). It installs
  alongside the hosted Acard app. On its first start it reads the server address saved by the OpenNotion app, so you
  do not need to reconnect.
- Nothing changes for your data: the server keeps the same `ACARD_*` settings, data folder and file format.

### Documentation

- README in English, Korean and Simplified Chinese.
- New: [Why Acard](docs/why-acard.md) (compared with Notion and Obsidian) and [Architecture](docs/architecture.md).
- New: contributing guide, code of conduct, security policy, issue and pull request templates, CI workflow.

### Since v0.1.0

- Backups: one archive with every table, every file and a Markdown copy of each page; daily automatic backups.
- Optional connection to a hosted account for publishing, off-site backup and multi-device sync.
- Columns, block colors, buttons, page icons and covers, database relations, sub-items, formulas and parts.

## v0.1.0 - 2026-10-18

- First public release as OpenNotion: self-hosted server, LAN mode with password sign-in, Windows desktop client.
