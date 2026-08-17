# maison-x9k2m7q4

## Browser automation

[agent-browser](https://github.com/vercel-labs/agent-browser) drives a real Chrome
from the command line, which is handy for checking `index.html` renders correctly.

```bash
scripts/setup-agent-browser.sh          # install + sandbox fixes (idempotent)

agent-browser open http://localhost:8000/index.html
agent-browser snapshot -i               # interactive elements with @refs
agent-browser screenshot shot.png
```

The setup script exists because a plain `npm i -g agent-browser` leaves the browser
unable to reach the network from inside a Claude Code sandbox — see the comments at
the top of the script for what it fixes and why.
