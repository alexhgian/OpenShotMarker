import { describe, it, expect } from 'vitest';
import { markersToCsv, cameraKeyMap, CSV_COLUMNS } from '../../src/core/export/csv';
import {
  buildTcfix,
  tcfixToJson,
  tcfixFilename,
  verifyTcfix,
  TCFIX_FORMAT,
  TCFIX_VERSION,
  GENERATOR,
} from '../../src/core/export/tcfix';
import { createMarker, createSession, createCamera, softDelete } from '../../src/core/markers';
import type { Marker, Camera, Session } from '../../src/core/markers';
import { TcClock, OFFSET_MEANING, type ClockReading } from '../../src/core/clock';
import { tcToFrames } from '../../src/core/timecode';

const fixedRandom = (len: number) => new Uint8Array(len).fill(0);
const NOW = 1_757_000_000_000;
const running = (ms: number): ClockReading => ({ mono: ms, wall: NOW + ms });

function fixture(): { session: Session; cameras: Camera[]; markers: Marker[] } {
  const session: Session = {
    ...createSession({
      label: 'elfyou — Tuesday',
      fps: '29.97',
      drop_frame: true,
      device: 'alex-iphone',
      nowMs: NOW,
      random: fixedRandom,
    }),
  };
  const a: Camera = {
    ...createCamera({
      session_id: session.id,
      key: 'A',
      fps: '29.97',
      drop_frame: true,
      label: 'FX30 main',
      nowMs: NOW,
      random: fixedRandom,
    }),
    id: 'cam-a',
    last_locked_at: '2026-09-15T18:03:40Z',
    lock_quality: { inliers: 14, residual_frames: 0.4 },
  };
  const b: Camera = {
    ...createCamera({
      session_id: session.id,
      key: 'B',
      fps: '29.97',
      drop_frame: true,
      label: 'FX30 wide',
      bin_hint: 'CAM B',
      nowMs: NOW,
      random: fixedRandom,
    }),
    id: 'cam-b',
    offset_frames: -4471,
    offset_measured_at: '2026-09-15T18:05:12Z',
    offset_confidence_frames: 1,
    lock_quality: { inliers: 11, residual_frames: 0.6 },
  };

  const clock = new TcClock({
    fps: '29.97',
    drop: true,
    anchor: { tcFrame: tcToFrames('10:14:22;07', '29.97', true), ...running(0) },
  });

  const markers = [
    createMarker({
      session_id: session.id,
      camera_id: 'cam-a',
      type: 'great',
      captured: running(0),
      prerollMs: 0,
      clock,
      device: 'alex-iphone',
      note: 'second chorus, the hair flip',
      source: 'voice',
      nowMs: NOW,
      random: fixedRandom,
    }),
  ];
  return { session, cameras: [a, b], markers };
}

describe('§10.3 CSV', () => {
  it('writes the documented header and one row per marker', () => {
    const { cameras, markers } = fixture();
    const csv = markersToCsv(markers, { cameraKeys: cameraKeyMap(cameras) });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('timecode,frame,camera,type,note,source,clock,created,device');
    expect(CSV_COLUMNS).toHaveLength(9);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('10:14:22;07,1104761,A,great,');
    expect(lines[1]).toContain('voice');
    expect(lines[1]).toContain('alex-iphone');
  });

  it('quotes notes containing commas, quotes and newlines', () => {
    const { markers } = fixture();
    const m = { ...markers[0]!, note: 'he said "go", then\nshe left' };
    const csv = markersToCsv([m]);
    expect(csv).toContain('"he said ""go"", then\nshe left"');
    // Still exactly one header and one record as far as a parser is concerned.
    expect(csv.split('\r\n')[0]).toBe(CSV_COLUMNS.join(','));
  });

  it('falls back to the raw camera id when no key map is given', () => {
    const { markers } = fixture();
    expect(markersToCsv(markers)).toContain(',cam-a,');
  });

  it('writes a header-only file for a session with no markers', () => {
    expect(markersToCsv([])).toBe(CSV_COLUMNS.join(',') + '\r\n');
  });

  it('honours a custom line ending', () => {
    const { markers } = fixture();
    expect(markersToCsv(markers, { eol: '\n' })).not.toContain('\r');
  });
});

describe('§10.4 the fix file', () => {
  it('has format and version up front so the plugin can refuse what it does not know', () => {
    const f = buildTcfix(fixture());
    expect(f.format).toBe(TCFIX_FORMAT);
    expect(f.version).toBe(TCFIX_VERSION);
    expect(f.generator).toBe(GENERATOR);
  });

  it('carries the session, the cameras and the markers in one file', () => {
    const f = buildTcfix(fixture());
    expect(f.session.label).toBe('elfyou — Tuesday');
    expect(f.session.device).toBe('alex-iphone');
    expect(f.reference_camera).toBe('A');
    expect(Object.keys(f.cameras)).toEqual(['A', 'B']);
    expect(f.markers).toHaveLength(1);
  });

  it('matches the example file for the same marker', () => {
    const f = buildTcfix(fixture());
    const m = f.markers[0]!;
    expect(m.camera).toBe('A');
    expect(m.tc).toBe('10:14:22;07');
    expect(m.frame).toBe(1104761);
    expect(m.type).toBe('great');
    expect(m.color).toBe('Green');
    expect(m.note).toBe('second chorus, the hair flip');
    expect(m.source).toBe('voice');
    // §3.4 provenance rides along; TCFix.py ignores it.
    expect(m.clock).toBe('mono');
  });

  it('carries the §3.4 clock provenance per marker', () => {
    const fx = fixture();
    const stale = { ...fx.markers[0]!, clock: 'wall-fallback' as const };
    const f = buildTcfix({ ...fx, markers: [stale] });
    expect(f.markers[0]!.clock).toBe('wall-fallback');
  });

  it('writes offset_meaning on the non-reference camera only', () => {
    const f = buildTcfix(fixture());
    expect(f.cameras.B!.offset_meaning).toBe(OFFSET_MEANING);
    expect(f.cameras.B!.offset_frames).toBe(-4471);
    expect(f.cameras.B!.confidence_frames).toBe(1);
    expect(f.cameras.B!.bin_hint).toBe('CAM B');
    expect(f.cameras.A!.offset_meaning).toBeUndefined();
    expect(f.cameras.A!.offset_frames).toBe(0);
    expect(f.cameras.A!.bin_hint).toBeUndefined();
  });

  it('carries lock quality so a suspicious sync can be traced six months on', () => {
    const f = buildTcfix(fixture());
    expect(f.cameras.A!.lock_quality).toEqual({ inliers: 14, residual_frames: 0.4 });
    expect(f.cameras.B!.lock_quality).toEqual({ inliers: 11, residual_frames: 0.6 });
  });

  it('omits soft-deleted markers', () => {
    const fx = fixture();
    const f = buildTcfix({ ...fx, markers: [softDelete(fx.markers[0]!, NOW)] });
    expect(f.markers).toEqual([]);
  });

  it('refuses a session whose reference camera is not in the camera list', () => {
    const fx = fixture();
    expect(() =>
      buildTcfix({ ...fx, session: { ...fx.session, reference_camera: 'Z' } }),
    ).toThrow(/reference_camera "Z" is not in cameras/);
  });

  it('says "none" when the session has no cameras at all', () => {
    const fx = fixture();
    expect(() => buildTcfix({ ...fx, cameras: [], markers: [] })).toThrow(
      /is not in cameras \(none\)/,
    );
  });

  it('names the rate and DF state when tc and frame disagree, at NDF too', () => {
    const fx = fixture();
    const ndfCams = fx.cameras.map((c) => ({ ...c, drop_frame: false }));
    const m = { ...fx.markers[0]!, tc: '10:14:22:07', frame: 999 };
    expect(() => buildTcfix({ ...fx, cameras: ndfCams, markers: [m] })).toThrow(
      /is inconsistent: tc 10:14:22:07 is not frame 999 at 29\.97 NDF/,
    );
  });

  it('refuses a marker pointing at a camera that is not in the session', () => {
    const fx = fixture();
    expect(() =>
      buildTcfix({ ...fx, markers: [{ ...fx.markers[0]!, camera_id: 'ghost' }] }),
    ).toThrow(/unknown camera ghost/);
  });

  it('refuses a marker whose tc and frame disagree, rather than letting the plugin guess', () => {
    const fx = fixture();
    expect(() => buildTcfix({ ...fx, markers: [{ ...fx.markers[0]!, frame: 999 }] })).toThrow(
      /is inconsistent/,
    );
  });

  it('re-derives every frame from its tc', () => {
    const f = buildTcfix(fixture());
    expect(() => verifyTcfix(f)).not.toThrow();
    expect(() => verifyTcfix({ ...f, markers: [{ ...f.markers[0]!, frame: 12 }] })).toThrow(
      /derives frame/,
    );
    expect(() =>
      verifyTcfix({ ...f, markers: [{ ...f.markers[0]!, camera: 'Q' }] }),
    ).toThrow(/not listed/);
  });

  it('catches a frame that does not render back to the same label', () => {
    const f = buildTcfix(fixture());
    // 00:01:00;00 and ;01 do not exist at 29.97 DF: tcToFrames maps them onto the
    // same frame as ;02, so the round-trip check is the one that catches them.
    const bad = { ...f.markers[0]!, tc: '00:01:00;00', frame: tcToFrames('00:01:00;00', '29.97', true) };
    expect(() => verifyTcfix({ ...f, markers: [bad] })).toThrow(/does not render back/);
  });

  it('serialises as pretty JSON ending in a newline', () => {
    const json = tcfixToJson(buildTcfix(fixture()));
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json).format).toBe('tcfix');
    expect(json).toContain('\n  "format": "tcfix"');
  });

  it('slugs the session label into a filename the plugin will glob', () => {
    const { session } = fixture();
    expect(tcfixFilename(session)).toBe('elfyou-tuesday.tcfix.json');
    expect(tcfixFilename({ ...session, label: '  ///  ' })).toBe('session.tcfix.json');
    expect(tcfixFilename({ ...session, label: 'x'.repeat(80) })).toBe(
      'x'.repeat(48) + '.tcfix.json',
    );
  });
});
