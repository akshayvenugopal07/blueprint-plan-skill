# Maintenance (for the owner)

Nothing here is needed to use the skill. An agent should run these only when the owner asks.

## Check what is outdated or vulnerable

```sh
cd <skill folder>
npm run update:deps
```

This installs the pinned build packages if `node_modules/` is missing (integrity-checked against `package-lock.json`, install scripts disabled), then prints outdated packages and `npm audit` results. It changes nothing else.

## Update a package

```sh
npm run update:deps -- mermaid            # to the latest version
npm run update:deps -- dompurify@3.4.18   # to an exact version
npm run update:deps -- --all              # everything
```

This pins the new exact version, runs the audit, rebuilds `dist/`, runs the tests, and rewrites `CHECKSUMS.sha256`. Review the printed version changes and `git diff package.json package-lock.json` before trusting the result. To undo, restore the previous commit.

Only packages already listed in `package.json` can be updated this way. Adding a new package is a manual change on purpose.

## Rebuild after editing the app

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run checksums
```

## Verify the installed copy

```sh
node bin/blueprint.mjs verify
```

## Where plans and review data live

All plans live in `assets/plans/<slug>/` inside the skill folder. `assets/` is git-ignored, so plans never end up in the skill's repository.

Each plan folder holds the plan file, any exported HTML, and a `.blueprint/` folder with recorded drafts, the conversation, a server log (events only, no content), and attached images while a review is open. Delete a plan's folder to remove it and its history.

Each installed copy of the skill (for example under `~/.cursor/skills` and `~/.claude/skills`) has its own `assets/` folder.
