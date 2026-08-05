# Security

This repository is public **only because GitHub Pages requires it** to serve the
PRIVÉE app on the free tier. It is a personal project, not a product, and it has
no users other than its owner.

## What that means for you

Everything committed here is world-readable: the application, the curated venue
data, and the photography. Nothing in this repository is secret, and nothing
here should ever be. There are no credentials, no API keys and no personal
contact data in the tree, and `.gitignore` plus `.claude/settings.json` are
configured to keep it that way.

The app runs entirely in the browser. It has no backend, no account system, no
analytics and no telemetry. It stores nothing about you. The only outbound
request to a third party is to a URL shortener, and only when you explicitly tap
share.

## Reporting something

If you have found a genuine security problem — a leaked credential in the
history, a way the page could be made to execute untrusted content, a dependency
serving something it should not — please open a
[security advisory](https://github.com/mish5000/maison-x9k2m7q4/security/advisories/new)
rather than a public issue.

Please **do not** report:

- that the repository is public — that is deliberate and documented above
- that the site has no authentication — it is a static page with nothing to
  protect
- automated scanner output with no demonstrated impact

## Supported versions

Only the current `main` is supported. It is the live site; there are no
released versions and no backports.
