import { closeSync, openSync } from 'node:fs'
import { createContext } from './context.js'
import { runFinishJob } from './finish-runner.js'
import { readJson } from './store.js'

const resultFile = process.argv[2]
const job = readJson(resultFile, null)
if (!job || job.status !== 'queued') process.exit(0)
// Persist the claim: replay after crash must never repeat release or close.
try { closeSync(openSync(`${resultFile}.worker`, 'wx', 0o600)) } catch (error) {
  if (error.code === 'EEXIST') process.exit(0)
  throw error
}
const result = await runFinishJob(createContext(job.context), job, resultFile)
process.exitCode = result.code ?? 1
