/**
 * CSV export (§10.3) — the sanity check when an import looks wrong.
 * Columns: timecode,frame,camera,type,note,source,created,device
 */

import type { Marker, Camera } from '../markers';

export const CSV_COLUMNS = [
  'timecode',
  'frame',
  'camera',
  'type',
  'note',
  'source',
  'clock',
  'created',
  'device',
] as const;

/**
 * RFC 4180 quoting. A note is free text typed by an operator mid-show: it will contain
 * commas, quotes and newlines, and a spreadsheet that silently splits one into two rows
 * is worse than no export at all.
 */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvOptions {
  /** camera_id -> operator-facing key ('A', 'B'). Falls back to the raw id. */
  cameraKeys?: Record<string, string>;
  /** CRLF per RFC 4180; Excel is happier and Resolve does not read this file. */
  eol?: string;
}

export function markersToCsv(markers: Marker[], opts: CsvOptions = {}): string {
  const eol = opts.eol ?? '\r\n';
  const keys = opts.cameraKeys ?? {};
  const rows = [CSV_COLUMNS.join(',')];
  for (const m of markers) {
    rows.push(
      [
        csvCell(m.tc),
        csvCell(m.frame),
        csvCell(keys[m.camera_id] ?? m.camera_id),
        csvCell(m.type),
        csvCell(m.note),
        csvCell(m.source),
        csvCell(m.clock),
        csvCell(m.created_at),
        csvCell(m.device),
      ].join(','),
    );
  }
  return rows.join(eol) + eol;
}

export function cameraKeyMap(cameras: Camera[]): Record<string, string> {
  return Object.fromEntries(cameras.map((c) => [c.id, c.key]));
}
