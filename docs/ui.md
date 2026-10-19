# Local read-only dashboard

OMF remains CLI first. Run the optional dashboard from your repository:

```sh
omf ui
omf ui --port 4321 --no-open
```

`--port` accepts an integer from `0` to `65535`; `0` is the default and chooses an available port. The server binds to loopback and prints a session URL with a random capability token. By default OMF opens that URL in your browser. `--no-open` prints it without opening a browser. If opening fails, the server stays available at the printed URL. Press Ctrl+C in the terminal to stop it; a later session has a different URL.

The dashboard reads state. It does not initialize a project, run a measurement or agent, approve a decision, resume or cancel work, raise a budget, merge, or deploy. Use the CLI for those actions. An uninitialized repository is shown as uninitialized; starting the UI does not create its factory state.

Underlying goal audits can run read-only Git commands and create temporary index files. This observation path does not persist changes to repository content, its normal index, or OMF state.

## Reading the view

Select a goal ID in the left rail; the filter searches IDs locally. Overview counts cover goals included in the snapshot, while the workboard, human-attention items and evidence belong to the selected goal. The ledger activity section includes recent selected-goal and workspace events. Lists are bounded; a truncation notice means older or additional items may be omitted.

**Running** counts goals whose audit is approved and whose run state is running. A raw running run state alone does not make a draft, tampered or re-approval goal runnable. A run in `finish` is displayed as **Success candidate · awaiting human sign-off**; that candidate is not goal sign-off. When verification is unavailable, the goal list and count are withheld. Incomplete human-attention projection is explicitly unknown, even if some attention items are recorded.

The header identifies the verified ledger revision and the last successful refresh. Refresh manually, or enable optional 15-second refreshes while the tab is visible. If a refresh fails, the previous snapshot remains visible with an explicit stale notice. No browser interaction changes OMF state.

Polling is opt-in because each refresh can repeat audits and Git reads. There is no audit cache based only on Git HEAD: dirty working-tree changes and changed lock files can affect an audit without changing HEAD.

**Last disclosed gap** shows only a verified, previously disclosed direction and size bucket from the current approved goal contract. Its timestamp and ledger event identify when it was disclosed. It is not a new measurement. A later measurement, changed contract, missing provenance, or missing disclosure can make the current gap unavailable.

**Disclosure history** is a sequence of coarse disclosures whose current-contract provenance can be verified. It is not a numeric metric chart: changes in buckets do not prove numerical improvement. Missing or incomparable history is labeled unavailable, never filled with sample data or zero values.

**Evidence** shows the recorded recommendation separately from human approval. Report verification details are withheld because mutable report files cannot establish those details from the ledger alone; inspect them through the CLI. A recorded recommendation is not an approval or a merge authorization. A verified ledger chain proves record integrity, not evidence quality.

## Privacy and access

The browser receives an explicit projection of IDs, closed status/reason codes, counts, timestamps and coarse buckets. It does not receive goal objectives, work titles, decision questions, notes, raw metric values/names/units, commands, private paths, actor emails, logs, or sealed scenario content. All browser assets are local; no external fonts, analytics, or CDN are used.

The printed URL grants access to that local server session. Authentication applies to the page, assets and snapshot endpoint. The server validates the expected loopback host and any Origin header; mutation methods are rejected. It also allows capability-authenticated, cross-site, top-level GET navigation to the dashboard page so a local launch file can open it. This exception requires navigation/document metadata and does not apply to APIs, scripts or styles. It is not proof that the request came from a local file: another page with the capability can initiate the same navigation. The token is session access control, not an invitation to expose the server through a remote proxy.

The command assumes a trusted local machine. To keep the capability out of operating-system opener arguments, automatic opening uses a temporary HTML redirect file. Its directory is owner-only (`0700`), and the file is owner-only (`0600`) before the URL is written. The opener receives only the file path, without shell interpolation. No script or external resource is needed for the redirect.

The file stays available for the UI session even after the opener exits, because the browser may read it later. OMF removes it when opening fails, on normal process exit, or when the UI shuts down. Removal errors produce a generic warning and can be retried at process exit. Forced termination such as SIGKILL or a host crash may leave the private file behind; its URL stops working when that server session ends. `--no-open` creates no launch file. These temporary files do not change repository content or OMF state.

The capability remains visible in terminal output and the browser URL/history. Owner permissions do not hide it from processes running as the same user or a privileged user. The URL does not provide shared-host isolation.

## Reading and output limits

The reader checks the ledger's safe path, regular-file type and size before the normal ledger read. It accepts a ledger up to 16 MiB and up to 20,000 verified events. Checked state files must be regular files of at most 1 MiB each, with a 32 MiB aggregate limit separate from the ledger. These checks cover selected goals' `goal.md`, valid work items' `item.md`, `intent.md` and `evidence.json`, goal/metric lock JSON, proposed metric JSON and bands YAML. Non-regular checked files, including FIFOs, are refused.

Directory limits are 1,000 entries in the goal root, 1,000 entries in each selected goal's work root, 2,000 work directories across the selected goals, and 1,000 entries in each inspected metric directory. Per-directory entry limits count every entry type before filtering. Exceeding an input limit returns an unavailable snapshot with `resource_limit`.

Output includes at most 50 goals, 500 work cards across those goals, 100 recent allowlisted events and 30 disclosure points per goal. Output omissions are marked as truncated. Once the work-card budget is exhausted, later goals are omitted; their counts are not represented as zero.

These checks mitigate accidental state volume. The existing recursive symlink check and separate preflight/read steps remain, and filesystem checks and reads are not atomic. The limits provide no hard response-time or memory guarantee and no isolation from an attacker running as the same local user and changing state during a read.

## Missing and stale state

- **Not initialized:** no factory state exists. Initialize through the CLI when you intend to create it.
- **Ledger integrity unavailable:** the ledger failed verification; factory details are withheld.
- **Snapshot unavailable:** safe state could not be read, or state changed during collection. Refresh to retry.
- **Partially unavailable:** a section cannot be verified. Its warning remains visible; an empty attention or evidence list is not proof of success.
- **Reading limit reached:** state exceeds a safe resource limit; unavailable details are withheld rather than read without bounds.
- **Refresh failed:** the last successful snapshot is stale. Retry or reopen the URL from the running UI command if the session has ended.

The [design contract](../DESIGN.md) describes the dashboard's information hierarchy and accessibility behavior. The UI uses system light/dark preference, keyboard controls, visible focus indicators and stacked layouts on narrow screens.
