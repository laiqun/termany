import assert from "node:assert/strict";
import test from "node:test";
import type { IBufferCell, Terminal } from "@xterm/xterm";
import { computeLocalLinks } from "./localLinks";

class MockCell {
  chars = " ";
  width = 1;
  getChars() {
    return this.chars;
  }
  getWidth() {
    return this.width;
  }
}

class MockLine {
  readonly isWrapped: boolean;
  readonly length: number;
  private readonly text: string;

  constructor(text: string, cols: number, isWrapped = false) {
    this.text = text.padEnd(cols);
    this.length = cols;
    this.isWrapped = isWrapped;
  }

  getCell(x: number, cell: MockCell) {
    cell.chars = this.text[x] ?? " ";
    cell.width = 1;
    return cell;
  }
}

function mockTerminal(lines: MockLine[], cols: number): Terminal {
  const cell = new MockCell();
  return {
    cols,
    buffer: {
      active: {
        getLine: (y: number) => lines[y],
        getNullCell: () => cell as unknown as IBufferCell,
      },
    },
  } as unknown as Terminal;
}

test("recognizes one local path split across terminal rows", async () => {
  const cols = 64;
  const path = "/Users/idoubi/Downloads/Termany-windows-ae13f58/nsis/Termany_0.1.21_x64-setup.exe";
  const prefix = "  ";
  const cut = cols - prefix.length;
  const first = prefix + path.slice(0, cut);
  const second = path.slice(cut);
  const terminal = mockTerminal(
    [new MockLine(first, cols), new MockLine(second, cols, true)],
    cols
  );
  let candidates: string[] = [];

  const links = await computeLocalLinks(2, terminal, async (paths) => {
    candidates = paths;
    return paths.map((value) => value);
  });

  assert.deepEqual(candidates, [path]);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, path);
  assert.deepEqual(links[0].range.start, { x: prefix.length + 1, y: 1 });
  assert.equal(links[0].range.end.y, 2);
});

test("does not concatenate unrelated short physical lines", async () => {
  const cols = 80;
  const path = "/Users/idoubi/Downloads/nsis/";
  const terminal = mockTerminal(
    [new MockLine(path, cols), new MockLine("Termany_0.1.21_x64-setup.exe", cols)],
    cols
  );

  const links = await computeLocalLinks(1, terminal, async (paths) => paths);

  assert.equal(links.length, 1);
  assert.equal(links[0].text, path);
  assert.equal(links[0].range.end.y, 1);
});
