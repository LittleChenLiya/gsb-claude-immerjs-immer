# Audit-log patch redaction example

`print-audit-copy.ts` shows how to build a safe audit entry from Immer patches with `redactPatches`:

- `/user/token` is replaced with the explicit marker `[REDACTED]`;
- `/user/name` is preserved;
- the rule for `credentials` masks the whole parent value subtree;
- `remove` patches keep their original `op` / `path` (they carry no value);
- the returned copy shares no mutable object with the input patches;
- the original patches are not modified and still replay with `applyPatches` to the original next state.

Run it via the dedicated Vitest case (which also prints the audit copy):

```sh
npx vitest run __tests__/redact-audit-example.ts
```

See the [Audit patches](../../website/docs/audit-patches.mdx) documentation for the full API reference.
