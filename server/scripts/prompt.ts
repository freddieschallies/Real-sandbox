import { createInterface } from 'node:readline';

/** Asks a question without showing what is typed (for passwords). */
export async function askHidden(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => { if (s.startsWith(q)) out.output.write(q); };
  const ans = await new Promise<string>(r => rl.question(q, r));
  rl.close();
  process.stdout.write('\n');
  return ans;
}
