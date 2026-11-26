import test from 'node:test';
import assert from 'node:assert/strict';
import { isInit, isNamed, manifestNames } from './manifest-names.ts';

const SCOPE = 'https://ds.example/live/';

test('init segments come from the manifest, not the file name (DASH)', () => {
  const mpd = '<MPD><SegmentTemplate initialization="hdr-$RepresentationID$.bin" media="seg-$Number$.m4s"/></MPD>';
  const set = manifestNames(`${SCOPE}m.mpd`, mpd, SCOPE);
  assert.equal(isInit(`${SCOPE}hdr-v1.bin`, set), true);
  assert.equal(isInit(`${SCOPE}seg-1.m4s`, set), false);
  assert.equal(isNamed(`${SCOPE}seg-1.m4s`, set), true);
  // A segment that merely looks like an init file is not one unless the manifest says so.
  assert.equal(isInit(`${SCOPE}init.mp4`, set), false);
});

test('init segments come from #EXT-X-MAP (HLS); keys are never named', () => {
  const m3u8 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="start.dat"\n#EXTINF:2,\ns1.m4s\n';
  const set = manifestNames(`${SCOPE}media.m3u8`, m3u8, SCOPE);
  assert.equal(isInit(`${SCOPE}start.dat`, set), true);
  assert.equal(isInit(`${SCOPE}s1.m4s`, set), false);
  assert.equal(isNamed(`${SCOPE}key.bin`, set), false);
});

test('init outside the scope is not named', () => {
  const set = manifestNames(`${SCOPE}m.mpd`, '<MPD><SegmentTemplate initialization="https://evil.example/i.mp4" media="s.m4s"/></MPD>', SCOPE);
  assert.equal(isInit('https://evil.example/i.mp4', set), false);
});
