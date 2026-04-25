# Rules Style POC

Run:

```powershell
python .\photopea_batch\07_photopea_rules_style_poc.py
```

Then open:

```text
http://127.0.0.1:5002
```

What this POC does:

- opens `AgathaNew.psd` in Photopea
- targets only the `Rules` text layer
- applies plain text first
- optionally attempts mixed styling with `executeAction("set", descriptor)`
- saves the returned PSD into `photopea_batch/output_rules_style_poc/`

What to look for in the log:

- `DBG:plainTextApplied`
- `DBG:totalTextStyle:...`
- `DBG:runs:...`
- `DBG:descriptorReady`
- `DBG:executeActionReturned`
- `SAVE:styled`
- any `ERR:...` message

Important:

- This is a proof-of-concept harness, not a confirmed production solution.
- The styled path deliberately uses a Photoshop-like action descriptor because
  that is the main free hypothesis worth testing in Photopea.
- If the styled path fails but the plain path succeeds, that is evidence that
  whole-layer text replacement works while substring styling is still blocked.
