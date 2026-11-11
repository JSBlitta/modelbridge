@README.md

## Working on this repo

- Run the three checks in README "Develop" before every commit; a failure on the Windows target costs a release round trip.
- A new import or push to Produuzit goes through the push gate: a preview endpoint that issues a token and a push endpoint that requires it. Anything else that writes needs at least a read-only check and a confirm tick in the UI.
- New UI text goes into both `en.js` and `nl.js`.
- Do not bump Node or better-sqlite3 without checking a win32 prebuilt binary exists for every Node version `setup.bat` accepts.
- The live Produuzit and Trimble APIs are production systems: test against them only with a check/preview call, never a push, unless the user asks.
