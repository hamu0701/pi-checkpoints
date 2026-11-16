# pi-checkpoints

Pi's `/tree` rewinds the conversation. This extension rewinds the files too.

```sh
pi install git:github.com/hamu0701/pi-checkpoints
```

Every agent turn is committed to a bare repo under `~/.pi/agent/checkpoints/`, passed to
git with `--git-dir` and `--work-tree`, so your own repository is never touched and
folders without git work the same. Navigating commits the current state first, then
restores the nearest snapshot of the target.

Ignored files are not snapshotted. Empty directories and nested repositories are skipped,
and a forked session starts empty.

The tests are in `checkpoints.test.mjs`. The session cases need a logged-in Pi.

```sh
npm install
npm test
```
