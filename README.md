# Cipher CLI

A powerful AI CLI powered by [Cipher](https://cipherend.vercel.app) API, built by [vatistasdimitris](https://github.com/vatistasdimitris).

## Features

- Interactive terminal UI with arrow key navigation
- Session-based chat history (auto-saved to markdown files)
- Markdown rendering (**bold**, *italic*, `code`, links, headers)
- Settings picker (thinking, tools, memory toggle)
- Session picker to switch between chats
- Persistent memory storage for AI context
- Auto-clears terminal on startup
- Auto-loads latest session on restart

## Installation

```bash
# 1. Install bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# 2. Clone the repo
git clone https://github.com/vatistasdimitris01/cipher-cli-v2.git
cd cipher-cli-v2

# 3. Run!
bun run index.ts
```

## Quick Start

```bash
# Just run - it auto-starts latest session or creates new one
bun run index.ts
```

## Commands

| Command | Description |
|---------|------------|
| `/help` | Show all commands |
| `/model` | Switch AI model (picker) |
| `/effort` | Set effort level (low/medium/high) |
| `/memory` | Save or list memories |
| `/new` | Start a new session |
| `/sessions` | Switch session (picker) |
| `/settings` | Open settings (picker) |
| `/profile` | View your profile |
| `/clear` | Clear conversation |
| `/exit` | Exit CLI |

## Navigation

- **↑↓** - Navigate lists/pickers
- **Enter** - Select item
- **Esc** - Cancel/go back
- **Ctrl+C** - Cancel current input
- **Ctrl+D** - Exit CLI

## Session Switching

```bash
# Option 1: Use /sessions command
bun run index.ts
# Press /sessions, select session with arrows, press Enter

# Option 2: Pass session ID as argument
bun run index.ts --session 123456
```

## Settings

Access via `/settings` command:
- **thinking**: Show AI reasoning process
- **tools**: Display tool calls and results  
- **memory**: Allow AI to save memories

Current settings shown in banner on startup.

## Files & Storage

Sessions saved to: `~/.cipher/sessions/`
- `sessions.md` - All sessions list
- `{id}.md` - Individual session chats

Memories saved to: `~/.cipher/users/{slug}/memories/`

## Credits

- **Cipher API** - https://cipherend.vercel.app
- **Created by** - [vatistasdimitris](https://github.com/vatistasdimitris)

## License

MIT