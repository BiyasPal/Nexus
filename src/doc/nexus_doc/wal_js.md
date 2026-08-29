# `wal.js` — Write-Ahead Log (WAL) Module

## 1. Overview

The `wal.js` module implements a **Write-Ahead Log (WAL)** system for recording important request lifecycle events before or while they are being processed.

The module records two primary event types:

- `start` — indicates that a request has started
- `finish` — indicates that a request has completed

These records are temporarily stored in memory and periodically written to a log file named:

```text
wal.log
```

The module also supports:

- Buffered logging
- Periodic flushing
- File rotation
- Configurable log retention
- WAL replay
- Detection of incomplete or in-flight requests
- Recovery from unclean shutdowns
- Optional WAL disabling
- Sequential asynchronous writes

The overall purpose is to provide a persistent record of request activity that can later be inspected during recovery.

---

# 2. Imported Modules

```js
import fs from 'node:fs';
import path from 'node:path';
```

## `node:fs`

The Node.js filesystem module is used for:

- Creating directories
- Checking whether files exist
- Reading files
- Writing/appending to files
- Renaming files
- Deleting old rotated files
- Reading directory contents
- Retrieving file statistics

Both synchronous and asynchronous filesystem APIs are used in this module.

---

## `node:path`

The `path` module is used to safely construct filesystem paths.

It prevents the code from manually concatenating directory names and filenames.

---

# 3. WAL Filename

```js
const WAL_FILENAME = 'wal.log';
```

This constant defines the name of the active WAL file.

The active WAL is therefore stored as:

```text
wal.log
```

When log rotation occurs, older files receive numbered suffixes such as:

```text
wal.log.1
wal.log.2
wal.log.3
```

---

# 4. `createWal()`

```js
export function createWal(walConfig, logger) {
```

## Purpose

`createWal()` creates and initializes a WAL manager.

It receives configuration information and returns an object containing the public WAL operations.

---

## Parameters

| Parameter | Description |
|---|---|
| `walConfig` | Configuration controlling WAL behavior |
| `logger` | Optional logger used for reporting errors |

A configuration can contain values such as:

```js
{
  path: './data/wal',
  flushIntervalMs: 1000,
  maxFileSizeBytes: 10485760,
  retainFiles: 5,
  enabled: true
}
```

---

# 5. Logger Initialization

```js
const log = logger || console;
```

If a custom logger is supplied, the module uses it.

Otherwise, the standard Node.js `console` object is used.

This allows the WAL module to work with the application's own logging system while still functioning independently.

---

# 6. WAL Configuration

```js
const walDir = path.normalize(walConfig.path);
const flushIntervalMs = walConfig.flushIntervalMs;
const maxFileSizeBytes = walConfig.maxFileSizeBytes;
const retainFiles = walConfig.retainFiles;
const enabled = walConfig.enabled !== false;
```

These values control the behavior of the WAL.

## `walDir`

The directory where WAL files are stored.

`path.normalize()` converts the supplied path into a normalized filesystem representation.

---

## `flushIntervalMs`

Controls how frequently the in-memory WAL buffer is flushed to disk.

For example:

```text
flushIntervalMs = 1000
```

means the WAL attempts to flush approximately every second.

---

## `maxFileSizeBytes`

Defines the maximum allowed size of the active WAL file before rotation is triggered.

---

## `retainFiles`

Defines how many rotated WAL files should be retained.

For example:

```text
retainFiles = 3
```

can result in:

```text
wal.log
wal.log.1
wal.log.2
wal.log.3
```

Older files beyond the configured retention count are deleted.

---

## `enabled`

```js
const enabled = walConfig.enabled !== false;
```

The WAL is enabled by default.

Only an explicit:

```js
enabled: false
```

disables it.

This means that:

```js
{}
```

and:

```js
{ enabled: true }
```

both enable WAL functionality.

---

# 7. Active WAL File Path

```js
const currentFilePath = path.join(walDir, WAL_FILENAME);
```

This constructs the complete path to the active WAL file.

For example:

```text
walDir:
./data/wal

WAL filename:
wal.log

Result:
./data/wal/wal.log
```

---

# 8. Internal State Variables

```js
let buffer = [];
let timer = null;
let flushing = Promise.resolve();
```

The module maintains three important pieces of internal state.

---

## `buffer`

Stores WAL entries temporarily in memory.

Instead of writing every event directly to disk, events are first added to this array.

Example:

```js
[
  {
    type: 'start',
    requestId: 'abc123',
    ts: 123456789
  },
  {
    type: 'finish',
    requestId: 'abc123',
    ts: 123456999
  }
]
```

This reduces the number of filesystem writes.

---

## `timer`

Stores the interval created by `setInterval()`.

It is initially `null`, meaning periodic flushing has not started.

---

## `flushing`

```js
let flushing = Promise.resolve();
```

This Promise is used as a **write queue**.

Each WAL flush is chained onto the previous flush so that multiple asynchronous writes do not modify the WAL file concurrently.

This is an important part of maintaining ordered WAL writes.

---

# 9. `ensureDir()`

```js
function ensureDir() {
  fs.mkdirSync(walDir, { recursive: true });
}
```

## Purpose

Ensures that the WAL directory exists.

The `recursive: true` option means Node.js will create any missing parent directories as well.

For example, if:

```text
data/wal
```

does not exist, the function creates the required directory structure.

---

# 10. `rotatedPath()`

```js
function rotatedPath(index) {
  return path.join(walDir, `${WAL_FILENAME}.${index}`);
}
```

## Purpose

Generates the path of a rotated WAL file.

Examples:

```js
rotatedPath(1)
```

produces:

```text
wal.log.1
```

and:

```js
rotatedPath(3)
```

produces:

```text
wal.log.3
```

This function centralizes the naming convention for rotated WAL files.

---

# 11. `rotate()`

```js
function rotate() {
```

## Purpose

Rotates the current WAL file when it reaches the configured size limit.

The rotation process shifts existing files upward:

```text
wal.log.1 → wal.log.2
wal.log.2 → wal.log.3
wal.log   → wal.log.1
```

The oldest file is removed when the retention limit is reached.

---

# 12. Rotating Existing Files

```js
for (let i = retainFiles; i >= 1; i -= 1) {
```

The loop starts from the oldest allowed index and works backward.

Working backward is important because it prevents overwriting a file before it has been moved.

---

## Checking for Existing Files

```js
const src = rotatedPath(i);
if (!fs.existsSync(src)) continue;
```

If a rotated file does not exist, it is skipped.

---

## Removing Files Beyond Retention

```js
if (i + 1 > retainFiles) {
  fs.unlinkSync(src);
}
```

If moving a file would exceed the configured retention count, that file is deleted.

For example, with:

```text
retainFiles = 3
```

`wal.log.3` is the oldest retained file.

A new rotation would cause it to be deleted rather than moved to:

```text
wal.log.4
```

---

## Moving Existing Rotated Files

```js
else {
  fs.renameSync(src, rotatedPath(i + 1));
}
```

Existing rotated files are shifted to the next index.

For example:

```text
wal.log.1 → wal.log.2
wal.log.2 → wal.log.3
```

---

# 13. Moving the Active WAL

```js
if (fs.existsSync(currentFilePath)) {
  fs.renameSync(currentFilePath, rotatedPath(1));
}
```

After older rotated files have been shifted, the current:

```text
wal.log
```

is renamed to:

```text
wal.log.1
```

The next write will recreate `wal.log`.

---

# 14. `rotateIfNeeded()`

```js
function rotateIfNeeded() {
```

## Purpose

Checks whether the active WAL file has reached its maximum configured size.

---

## File Existence Check

```js
if (!fs.existsSync(currentFilePath)) return;
```

If the active WAL does not exist, there is nothing to rotate.

---

## Checking File Size

```js
const stats = fs.statSync(currentFilePath);
if (stats.size >= maxFileSizeBytes) {
  rotate();
}
```

The file's current size is retrieved using `fs.statSync()`.

If:

```text
current file size >= maxFileSizeBytes
```

the `rotate()` function is called.

---

# 15. `recordStart()`

```js
function recordStart(requestId, meta = {}) {
```

## Purpose

Records the beginning of a request.

---

## WAL Disabled Check

```js
if (!enabled) return;
```

If WAL is disabled, the function immediately returns without recording anything.

---

## Adding the Entry to the Buffer

```js
buffer.push({
  type: 'start',
  requestId,
  ts: Date.now(),
  ...meta
});
```

A start record is added to the in-memory buffer.

The entry contains:

| Property | Purpose |
|---|---|
| `type` | Identifies this as a start event |
| `requestId` | Identifies the request |
| `ts` | Timestamp of the event |
| `meta` | Additional caller-provided information |

---

## Example

```js
recordStart('req-123', {
  method: 'POST',
  path: '/users'
});
```

may produce:

```js
{
  type: 'start',
  requestId: 'req-123',
  ts: 1234567890,
  method: 'POST',
  path: '/users'
}
```

The spread operator:

```js
...meta
```

allows additional fields to be included without changing the WAL implementation.

---

# 16. `recordFinish()`

```js
function recordFinish(requestId, meta = {}) {
```

## Purpose

Records the completion of a request.

It follows the same structure as `recordStart()`.

The primary difference is:

```js
type: 'finish'
```

---

## Example

```js
recordFinish('req-123', {
  statusCode: 200
});
```

may produce:

```js
{
  type: 'finish',
  requestId: 'req-123',
  ts: 1234567999,
  statusCode: 200
}
```

Together, the start and finish records allow the system to determine whether a request completed successfully or was interrupted.

---

# 17. `flush()`

```js
async function flush() {
```

## Purpose

Writes the current in-memory WAL buffer to disk.

This is one of the most important functions in the module.

---

# 18. Early Exit Conditions

```js
if (!enabled) return;
if (buffer.length === 0) return;
```

There is nothing to do when:

1. WAL is disabled.
2. The buffer contains no entries.

This avoids unnecessary filesystem operations.

---

# 19. Detaching the Current Batch

```js
const batch = buffer;
buffer = [];
```

The current buffer is moved into a local `batch`.

A new empty buffer is immediately created.

This is important because new WAL entries can continue to be recorded while the previous batch is waiting to be written.

For example:

```text
Current buffer
      │
      ▼
    batch
      │
      └── writing to disk

New buffer
      │
      └── accepts new events
```

This prevents new requests from being blocked while an older batch is being flushed.

---

# 20. Converting Entries into WAL Lines

```js
const lines = `${batch.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
```

Every entry is converted into JSON.

Each JSON object is placed on its own line.

For example:

```text
{"type":"start","requestId":"abc","ts":100}
{"type":"finish","requestId":"abc","ts":200}
```

This is effectively a **JSON Lines / NDJSON-style** log format.

The final newline is explicitly added:

```js
\n
```

---

# 21. Ensuring the Directory Exists

```js
ensureDir();
```

Before writing, the module makes sure that the WAL directory exists.

---

# 22. Sequential Flush Queue

```js
flushing = flushing
  .then(() => fs.promises.appendFile(currentFilePath, lines, 'utf8'))
```

This is a critical design decision.

Instead of immediately starting another file write, the new write is chained onto the existing `flushing` Promise.

Conceptually:

```text
Flush 1
   │
   ▼
Flush 2
   │
   ▼
Flush 3
   │
   ▼
Flush 4
```

This ensures that WAL writes happen in sequence.

It reduces the risk of concurrent writes producing an unexpected ordering.

---

# 23. Appending to the WAL

```js
fs.promises.appendFile(
  currentFilePath,
  lines,
  'utf8'
)
```

The new batch is appended to the active WAL file.

The file is not overwritten.

Previous entries remain intact.

---

# 24. Checking for Rotation After Writing

```js
.then(() => {
  rotateIfNeeded();
})
```

After a successful write, the module checks the file size.

If the file has reached the configured size limit, rotation occurs.

This means rotation happens after the newly flushed entries have been persisted.

---

# 25. Flush Error Handling

```js
.catch((err) => {
  buffer = batch.concat(buffer);
  log.error(`WAL flush failed: ${err.message}`);
});
```

If writing the WAL fails, the batch is placed back into the buffer.

The order is:

```text
Failed batch
+
New entries that arrived during the flush
```

This prevents the failed batch from being permanently lost from memory.

An error is also written to the configured logger.

---

# 26. Waiting for the Flush

```js
await flushing;
```

The function waits for the current queued flush operation to complete.

Because `flushing` represents the chained write sequence, this also preserves the ordering of flush operations.

---

# 27. `start()`

```js
function start() {
```

## Purpose

Starts periodic WAL flushing.

---

## Preventing Multiple Timers

```js
if (!enabled || timer) return;
```

The function does nothing when:

- WAL is disabled
- A timer is already running

This prevents duplicate flush intervals.

---

# 28. Preparing the WAL Directory

```js
ensureDir();
```

The directory is created before periodic flushing starts.

---

# 29. Creating the Flush Timer

```js
timer = setInterval(() => {
  flush().catch((err) =>
    log.error(`WAL flush interval failed: ${err.message}`)
  );
}, flushIntervalMs);
```

A periodic timer calls `flush()` according to `flushIntervalMs`.

For example:

```text
flushIntervalMs = 1000
```

means the WAL is flushed approximately every second.

---

# 30. Timer `unref()`

```js
if (timer.unref) timer.unref();
```

`unref()` prevents the timer from keeping the Node.js process alive by itself.

Therefore, if the rest of the application has finished and no other handles are keeping the process alive, the process can exit naturally.

---

# 31. `stop()`

```js
async function stop() {
```

## Purpose

Stops periodic WAL flushing and performs a final flush.

---

## Stopping the Timer

```js
if (timer) {
  clearInterval(timer);
  timer = null;
}
```

The periodic timer is cancelled.

Setting:

```js
timer = null;
```

allows the WAL to be started again later.

---

## Final Flush

```js
await flush();
```

Any entries still present in memory are written to disk before the WAL manager stops.

This is important for graceful shutdown because otherwise buffered entries could be lost.

---

# 32. `listRotatedFilesNewestFirst()`

```js
function listRotatedFilesNewestFirst() {
```

## Purpose

Finds rotated WAL files in the WAL directory.

Despite its name, the implementation sorts the files by their numeric suffix in ascending order.

For example:

```text
wal.log.1
wal.log.2
wal.log.3
```

are returned in that order, where `.1` represents the newest rotated file.

---

# 33. Reading WAL Directory Contents

```js
let names;
try {
  names = fs.readdirSync(walDir);
} catch {
  return [];
}
```

The directory contents are read synchronously.

If the directory does not exist or cannot be read, an empty array is returned.

This allows replay operations to safely handle a missing WAL directory.

---

# 34. Selecting Rotated WAL Files

```js
.filter((name) => name.startsWith(`${WAL_FILENAME}.`))
```

Only files beginning with:

```text
wal.log.
```

are considered rotated WAL files.

For example:

```text
wal.log.1
wal.log.2
```

are included.

A random file such as:

```text
config.json
```

is ignored.

---

# 35. Sorting Rotated Files

```js
.sort(
  (a, b) =>
    Number(a.split('.').pop()) -
    Number(b.split('.').pop())
)
```

The numeric suffix is extracted from each filename.

For example:

```text
wal.log.3
```

produces:

```text
3
```

The files are then sorted numerically.

This avoids incorrect lexicographical ordering such as:

```text
wal.log.1
wal.log.10
wal.log.2
```

---

# 36. `readEntriesFromFile()`

```js
function readEntriesFromFile(filePath) {
```

## Purpose

Reads a WAL file and converts its JSON lines into JavaScript objects.

---

## Missing File Handling

```js
if (!fs.existsSync(filePath)) return [];
```

If the requested file does not exist, an empty array is returned.

---

# 37. Reading the File

```js
const content = fs.readFileSync(filePath, 'utf8');
```

The complete WAL file is read as UTF-8 text.

---

# 38. Splitting into Lines

```js
content
  .split('\n')
```

Each line represents one WAL entry.

---

## Removing Empty Lines

```js
.filter((line) => line.trim().length > 0)
```

Blank lines are ignored.

---

# 39. Parsing JSON Entries

```js
.map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
})
```

Every line is parsed as JSON.

If a line contains invalid or corrupted JSON, it becomes:

```js
null
```

instead of causing the entire replay process to fail.

---

## Removing Invalid Entries

```js
.filter((entry) => entry !== null);
```

Invalid entries are removed from the final result.

Therefore, a corrupted WAL line does not prevent other valid entries from being replayed.

---

# 40. `replay()`

```js
function replay(limit = 100) {
```

## Purpose

Reads recent WAL entries and determines whether there were any requests that started but never finished.

This is particularly useful after:

- Crashes
- Forced termination
- Power failures
- Unclean shutdowns
- Unexpected process termination

---

# 41. Collecting WAL Files

```js
const filesNewestFirst = [];
```

An array is created to store WAL files in newest-to-oldest logical order.

---

## Current WAL First

```js
if (fs.existsSync(currentFilePath)) {
  filesNewestFirst.push(currentFilePath);
}
```

The current active WAL is checked first because it contains the newest records.

---

## Adding Rotated Files

```js
filesNewestFirst.push(...listRotatedFilesNewestFirst());
```

Rotated WAL files are added afterward.

The resulting order is conceptually:

```text
wal.log
wal.log.1
wal.log.2
wal.log.3
...
```

---

# 42. Collecting Recent Entries

```js
const collectedNewestFirst = [];
```

This array stores entries starting from the newest entries.

---

## Reading Each File

```js
for (const filePath of filesNewestFirst) {
  const fileEntries = readEntriesFromFile(filePath);
```

Each WAL file is read and parsed.

---

# 43. Reading Each File Backward

```js
for (let i = fileEntries.length - 1; i >= 0; i -= 1) {
```

The entries inside each file are processed from the last entry toward the first.

This is important because the newest entries occur at the end of the file.

---

# 44. Replay Limit

```js
collectedNewestFirst.push(fileEntries[i]);
if (collectedNewestFirst.length >= limit) break;
```

Only a maximum of `limit` entries are collected.

The default is:

```text
100 entries
```

This prevents replay from unnecessarily reading an unlimited amount of WAL history.

---

# 45. Reversing the Collected Entries

```js
const entries = collectedNewestFirst.reverse();
```

Entries were initially collected newest-first.

They are reversed before being returned so that the final result is in chronological order.

Therefore:

```text
Newest → Oldest
```

becomes:

```text
Oldest → Newest
```

within the selected replay window.

---

# 46. Finding Started Requests

```js
const startedIds = new Set(
  entries
    .filter((e) => e.type === 'start')
    .map((e) => e.requestId)
);
```

A `Set` is created containing the request IDs of all `start` events.

Example:

```text
req-1
req-2
req-3
```

Using a `Set` makes request-ID lookup efficient and automatically removes duplicate IDs.

---

# 47. Finding Finished Requests

```js
const finishedIds = new Set(
  entries
    .filter((e) => e.type === 'finish')
    .map((e) => e.requestId)
);
```

A second `Set` contains all request IDs that have a corresponding `finish` event within the replayed entries.

---

# 48. Detecting In-Flight Requests

```js
const inFlightRequestIds = [...startedIds]
  .filter((id) => !finishedIds.has(id));
```

A request is considered **in-flight** when:

```text
start event exists
AND
finish event does not exist
```

For example:

```text
req-1 → start
req-1 → finish

req-2 → start

req-3 → start
req-3 → finish
```

The result would be:

```text
req-2
```

because `req-2` started but has no corresponding finish event.

---

# 49. Detecting an Unclean Shutdown

```js
uncleanShutdown: inFlightRequestIds.length > 0
```

The module considers the system to have experienced an unclean shutdown when at least one request appears to have started but not finished.

Therefore:

```text
inFlightRequestIds.length > 0
```

means:

```text
uncleanShutdown = true
```

Otherwise:

```text
uncleanShutdown = false
```

---

# 50. `replay()` Return Value

The function returns:

```js
{
  entries,
  uncleanShutdown,
  inFlightRequestIds
}
```

## `entries`

Contains the selected WAL entries.

## `uncleanShutdown`

Boolean indicating whether unfinished requests were detected.

## `inFlightRequestIds`

Contains the request IDs that started but did not have a corresponding finish event.

Example:

```js
{
  entries: [
    {
      type: 'start',
      requestId: 'req-101',
      ts: 1000
    },
    {
      type: 'finish',
      requestId: 'req-101',
      ts: 1100
    },
    {
      type: 'start',
      requestId: 'req-102',
      ts: 1200
    }
  ],
  uncleanShutdown: true,
  inFlightRequestIds: ['req-102']
}
```

---

# 51. Public API

At the end of `createWal()`, the module returns:

```js
return {
  recordStart,
  recordFinish,
  flush,
  start,
  stop,
  rotateIfNeeded,
  replay
};
```

These functions form the public interface of the WAL manager.

| Function | Purpose |
|---|---|
| `recordStart()` | Record request start |
| `recordFinish()` | Record request completion |
| `flush()` | Write buffered entries to disk |
| `start()` | Start periodic flushing |
| `stop()` | Stop flushing and perform final flush |
| `rotateIfNeeded()` | Rotate WAL if file size is too large |
| `replay()` | Read recent WAL entries and detect incomplete requests |

Internal helper functions such as:

- `ensureDir()`
- `rotatedPath()`
- `rotate()`
- `transition-like internal logic`

are not exposed to callers.

---

# 52. Complete WAL Lifecycle

The overall lifecycle can be visualized as:

```text
Request Starts
      │
      ▼
recordStart()
      │
      ▼
In-memory buffer
      │
      │
      ▼
Periodic flush()
      │
      ▼
wal.log
      │
      ▼
File reaches size limit
      │
      ▼
rotate()
      │
      ├── wal.log → wal.log.1
      ├── wal.log.1 → wal.log.2
      ├── wal.log.2 → wal.log.3
      └── oldest file → deleted
```

When the request finishes:

```text
Request Finishes
      │
      ▼
recordFinish()
      │
      ▼
In-memory buffer
      │
      ▼
flush()
      │
      ▼
wal.log
```

---

# 53. Crash / Recovery Flow

The WAL becomes especially useful during recovery.

Suppose the application records:

```text
start(req-1)
finish(req-1)

start(req-2)

start(req-3)
finish(req-3)
```

Then the application crashes.

During startup, the application can call:

```js
const result = wal.replay();
```

The module identifies:

```text
req-2
```

as an in-flight request.

The result indicates:

```js
{
  uncleanShutdown: true,
  inFlightRequestIds: ['req-2']
}
```

The higher-level application can then decide what recovery action should be performed for that request.

---

# 54. Why Buffering Is Used

The module does not immediately write every request event to disk.

Instead:

```text
recordStart()
      │
      ▼
Memory Buffer
      │
      ▼
flush()
      │
      ▼
Disk
```

This reduces filesystem operations.

Without buffering, a high-traffic server could potentially perform a disk write for every request event.

With buffering, multiple events can be written together as a batch.

---

# 55. Why the Flush Queue Is Important

The following mechanism:

```js
flushing = flushing
  .then(() => fs.promises.appendFile(...))
```

serializes WAL writes.

Suppose multiple flushes are triggered:

```text
Flush A
Flush B
Flush C
```

Instead of all three writing concurrently, they are chained:

```text
Flush A
   ↓
Flush B
   ↓
Flush C
```

This helps preserve the intended order of WAL data.

---

# 56. WAL File Format

The WAL uses one JSON object per line.

Example:

```text
{"type":"start","requestId":"req-1","ts":1000}
{"type":"finish","requestId":"req-1","ts":1050}
{"type":"start","requestId":"req-2","ts":1100}
```

This format provides several advantages:

- Human-readable
- Easy to parse
- Easy to append
- Each event is independently represented
- One malformed line does not necessarily invalidate the entire file

---

# 57. Important Failure-Handling Behavior

The module is designed to avoid losing buffered WAL entries when a disk write fails.

If:

```js
appendFile()
```

fails, the batch is restored:

```js
buffer = batch.concat(buffer);
```

Therefore:

```text
Failed batch
     +
Newly recorded events
     ↓
Restored buffer
```

The module also logs the failure.

This gives the application another opportunity to flush the entries later.

---

# 58. Graceful Shutdown Behavior

A typical shutdown sequence can be:

```js
wal.stop();
```

The `stop()` function:

1. Stops the periodic timer.
2. Prevents additional scheduled flushes.
3. Flushes any remaining in-memory entries.

This ensures that buffered WAL entries are persisted before the WAL manager shuts down.

---

# 59. File Rotation Strategy

Suppose:

```text
retainFiles = 3
```

and the current files are:

```text
wal.log
wal.log.1
wal.log.2
wal.log.3
```

When rotation occurs:

```text
wal.log.3 → deleted
wal.log.2 → wal.log.3
wal.log.1 → wal.log.2
wal.log   → wal.log.1
```

A new:

```text
wal.log
```

will then be created by the next append operation.

This keeps disk usage bounded according to the configured retention policy.

---

# 60. Overall Architecture

```text
                    WAL Manager
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
 recordStart()     recordFinish()      replay()
        │                │                │
        └────────┬───────┘                │
                 ▼                        │
            Memory Buffer                 │
                 │                        │
                 ▼                        │
              flush()                    │
                 │                        │
                 ▼                        │
              wal.log                     │
                 │                        │
                 ▼                        │
             Rotation                     │
                 │                        │
                 ▼                        │
       wal.log.1 / .2 / .3               │
                                          │
                                          ▼
                                  Detect in-flight
                                     requests
```

---

# 61. Summary

`wal.js` implements a lightweight **Write-Ahead Logging system** for request tracking and recovery.

Its main responsibilities are:

1. Record request-start events.
2. Record request-finish events.
3. Temporarily buffer WAL entries in memory.
4. Periodically persist buffered entries to disk.
5. Serialize asynchronous WAL writes.
6. Rotate WAL files when they exceed the configured size.
7. Retain only the configured number of rotated files.
8. Restore failed batches to memory when a flush fails.
9. Perform a final flush during shutdown.
10. Read recent WAL entries during recovery.
11. Detect requests that started but never finished.
12. Report whether an unclean shutdown is indicated.

The core recovery concept is:

```text
START event + no FINISH event
             =
       In-flight request
```

Therefore, this module acts as the application's **durability and request-recovery layer**, allowing the system to maintain a persistent record of request activity and identify work that may have been interrupted by an unexpected shutdown.