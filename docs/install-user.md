# Install for yourself (one computer)

This guide sets up Acard for one person on one computer. There is no server to manage, no account and no password:
the desktop app runs its own small server in the background and keeps everything on your computer.

Setting up Acard for a team instead? See [install-server.md](install-server.md).

## 1. Install the desktop app

| OS | How |
| --- | --- |
| Windows 10/11 (x64) | Download `Acard-Local-Setup-0.3.3.exe` from the [latest release](https://github.com/Hakubisual/open-notion-acard/releases/latest) and run it. It installs for your user only (no admin rights) and adds a Start menu and desktop shortcut. |
| macOS, Linux | Build it from source (below). Release builds for macOS and Linux are not published yet. |

The installer is not code-signed yet, so Windows SmartScreen may say *"Windows protected your PC"*. Click
**More info → Run anyway**.

Build from source (needs [Bun](https://bun.sh) 1.3 or newer; on macOS also the Xcode command line tools):

```sh
git clone https://github.com/Hakubisual/open-notion-acard.git
cd open-notion-acard
bun install          # the app the desktop build packs
cd desktop
bun install
bun run dist        # Windows: out/Acard-Local-Setup-<version>.exe
                    # macOS:   out/Acard-Local-<version>-<arch>.dmg (run on a Mac; built for that Mac's chip)
                    # Linux:   out/Acard-Local-<version>.AppImage (run on Linux)
```

## 2. First start

1. Open **Acard Local**. The first screen has two choices.
2. Choose **Use on this computer**. The app starts its built-in server and opens your workspace.
3. That is it. Next time the app opens your workspace straight away.

The app's language follows your operating system: Korean, Chinese, otherwise English.

The other choice, **Connect to a team server**, is for joining a server someone else runs
(see [install-client.md](install-client.md)). You can switch at any time from the menu **Server**:
*Use on this computer*, *Connect to a team server…* or *Change server…* (`Ctrl+Shift+S` / `Cmd+Shift+S`).

## 3. Where your data lives

Everything is stored in one folder:

| OS | Data folder |
| --- | --- |
| Windows | `%APPDATA%\Acard Local\data` |
| macOS | `~/Library/Application Support/Acard Local/data` |
| Linux | `~/.config/Acard Local/data` |

The folder holds the SQLite files (`acard.sqlite` for pages, blocks and databases, `media.sqlite` for images and
files) and a `backups` folder. Nothing in it is sent anywhere.

## 4. Backups

Open **My data** in the app (the address is `/__local/cloud` on your local server, for example
`http://127.0.0.1:47811/__local/cloud`). From there you can download a backup file: one zip with every table, every
file and a readable Markdown copy of each page. The same page restores a backup file. The app also keeps daily
automatic backups in the `backups` folder inside the data folder.

Keep a copy of a backup file on another disk or drive now and then. To move to another computer or to a team
server, restore that backup file there.

## 5. Port

The built-in server listens on `127.0.0.1` only, so other devices cannot reach it. It uses port `47811`; if that port
is busy, it takes the first free port from `47812` to `47830`. The address bar of a browser and your agents must
use the same port.

## 6. Connect your AI agent

Agents on the same computer connect without a token or an account, and nothing leaves the PC:

```sh
codex mcp add acard --url http://127.0.0.1:47811/mcp
claude mcp add --transport http acard http://127.0.0.1:47811/mcp
```

Any other MCP client:

```json
{ "mcpServers": { "acard": { "url": "http://127.0.0.1:47811/mcp" } } }
```

- REST API: `http://127.0.0.1:47811/api/v1`, described at `http://127.0.0.1:47811/api/v1/openapi.json`.
- Agent guide: `http://127.0.0.1:47811/AGENTS.md` and `http://127.0.0.1:47811/llms.txt`.
- CLI: `npx -y --package=http://127.0.0.1:47811/acard-cli.tgz acard pull ./notes` (commands `pull`, `push`, `mcp`,
  `whoami`; the default server is the local one).

Replace `47811` if the app chose another port (step 5).

## 7. Without the app

You can run the same server directly and use a browser. Install [Bun](https://bun.sh) 1.3 or newer, then:

```sh
git clone https://github.com/Hakubisual/open-notion-acard.git
cd open-notion-acard
bun install
bun run build
ACARD_DATA_DIR=./data ACARD_APP_DIR=./dist ACARD_LANG=en bun local/main.ts
```

Open `http://127.0.0.1:47811/`. Your data goes to the `data` folder you named. `ACARD_PORT` picks another port,
`ACARD_LANG` is `en`, `ko` or `zh`, and `ACARD_LOCAL_API=0` turns off the token-free agent access. Stop the server
with `Ctrl+C`.

## 8. Update

Download the newer installer from the [latest release](https://github.com/Hakubisual/open-notion-acard/releases/latest)
and run it over the old one. Your data folder stays as it is; the server upgrades its files in place on the next start.
Take a backup first.

Running without the app? `git pull`, `bun install`, `bun run build`, then start the server again.

## 9. Uninstall

On Windows, use *Settings → Apps → Installed apps → Acard Local*. Uninstalling keeps your data folder; delete
`%APPDATA%\Acard Local` yourself if you want your notes gone too (take a backup first).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Windows says the app is from an unknown publisher | Expected for unsigned builds; see step 1. |
| An agent cannot connect | Check that the app is open and the port matches (step 5). `http://127.0.0.1:47811/__local/health` prints `acard-local ok` when the server runs. |
| Port 47811 is used by something else | Nothing to do: the app picks the next free port. Use that port for agents. |
