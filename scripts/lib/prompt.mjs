// Tiny zero-dependency prompt helpers (numbered menus, yes/no, free text).
// Works in a real terminal and with piped input (handy for tests).

import readline from 'node:readline'

let rl = null
const queued = []
const waiting = []
let closed = false

export class InputEnded extends Error {}

function init() {
  if (rl) return
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queued.push(line)))
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()(null)
  })
  rl.on('SIGINT', () => {
    console.log()
    process.exit(130)
  })
}

export function closePrompts() {
  if (rl) rl.close()
}

/** Ask for a line of text. Throws InputEnded if stdin closes before an answer. */
export async function ask(prompt) {
  init()
  const answer = await new Promise((resolve) => {
    rl.setPrompt(prompt)
    rl.prompt()
    if (queued.length) return resolve(queued.shift())
    if (closed) return resolve(null)
    waiting.push(resolve)
  })
  if (answer === null) throw new InputEnded()
  if (!process.stdin.isTTY) console.log(answer) // echo piped answers so the transcript reads naturally
  return answer.trim()
}

export async function confirm(question, def = true) {
  for (;;) {
    const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
    if (a === '') return def
    if (a === 'y' || a === 'yes') return true
    if (a === 'n' || a === 'no') return false
    console.log('  Please answer y or n.')
  }
}

/** Numbered menu. options: [{ label, hint?, value }]. Returns the chosen value. */
export async function select(question, options, def = 0) {
  console.log(`\n${question}`)
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.hint ? `  ${o.hint}` : ''}`))
  for (;;) {
    const a = await ask(`Choose [${def + 1}]: `)
    if (a === '') return options[def].value
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
    console.log('  Enter a number from the list.')
  }
}
