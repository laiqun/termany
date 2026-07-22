import assert from "node:assert/strict";
import test from "node:test";
import { chordForPlatform, matchChord, type Chord } from "./keybindings";

function keyboardEvent(chord: Chord): KeyboardEvent {
  return {
    code: chord.code,
    metaKey: !!chord.meta,
    ctrlKey: !!chord.ctrl,
    shiftKey: !!chord.shift,
    altKey: !!chord.alt,
  } as KeyboardEvent;
}

test("keeps Command shortcuts on macOS", () => {
  assert.deepEqual(chordForPlatform({ code: "KeyT", meta: true }, true), {
      code: "KeyT",
      meta: true,
  });
});

test("maps Command shortcuts to Control on Windows", () => {
  const chord = chordForPlatform({ code: "KeyT", meta: true }, false);
  assert.deepEqual(chord, { code: "KeyT", meta: undefined, ctrl: true, alt: undefined });
  assert.equal(matchChord(keyboardEvent({ code: "KeyT", ctrl: true }), chord), true);
  assert.equal(matchChord(keyboardEvent({ code: "KeyT", meta: true }), chord), false);
});

test("maps Control+Command to Control+Alt without collapsing modifiers", () => {
  assert.deepEqual(
    chordForPlatform({ code: "ArrowLeft", meta: true, ctrl: true }, false),
    {
      code: "ArrowLeft",
      meta: undefined,
      ctrl: true,
      alt: true,
    }
  );
});
