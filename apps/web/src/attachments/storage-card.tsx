// Settings → Storage on the web (REQ §14.2–14.3, ADR 0021): what the attachment cache holds,
// its size limit, how large a file this browser fetches from the phone, and "Clear cache",
// which removes downloaded files only, never messages.
import { useEffect, useState } from 'react';

import { useChatClient } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { formatSize } from '@pingdost/attachments';

import {
  CACHE_LIMITS_MB,
  cacheLimitMb,
  fileCache,
  PHONE_FILE_LIMITS_MB,
  phoneFileLimitMb,
  setCacheLimitMb,
  setPhoneFileLimitMb,
} from './cache';
import { forgetUrls } from './view';

const mb = (value: number) => (value >= 1_000 ? `${value / 1_000} GB` : `${value} MB`);

export function StorageCard() {
  const client = useChatClient();
  const [usage, setUsage] = useState<{ files: number; bytes: number }>();
  const [limit, setLimit] = useState(cacheLimitMb);
  const [phoneLimit, setPhoneLimit] = useState(phoneFileLimitMb);
  const [notice, setNotice] = useState<string>();

  const refresh = () =>
    void fileCache()
      .usage()
      .then(setUsage, () => undefined);
  useEffect(refresh, []);

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Storage</CardTitle>
      <p className="text-muted">
        Files you open here are kept in this browser, still encrypted, so they open again quickly.
        The browser may clear them to free space; your phone keeps its own copies.
      </p>
      <p>
        {usage
          ? `${usage.files} ${usage.files === 1 ? 'file' : 'files'}, ${formatSize(usage.bytes)}`
          : 'Counting…'}
      </p>
      <label className="flex items-center gap-3">
        <span>Keep at most</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1"
          value={limit}
          onChange={(event) => {
            const next = Number(event.target.value);
            setLimit(next);
            setCacheLimitMb(next);
            void client?.applyCacheLimit().then(refresh, () => undefined);
          }}
        >
          {CACHE_LIMITS_MB.map((value) => (
            <option key={value} value={value}>
              {mb(value)}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted">The least recently opened go first.</span>
      </label>
      <label className="flex flex-wrap items-center gap-3">
        <span>Fetch files from my phone up to</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1"
          value={phoneLimit}
          onChange={(event) => {
            const next = Number(event.target.value);
            setPhoneLimit(next);
            setPhoneFileLimitMb(next);
          }}
        >
          {PHONE_FILE_LIMITS_MB.map((value) => (
            <option key={value} value={value}>
              {mb(value)}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted">
          Files sent before this browser was linked come from your phone while it is online.
        </span>
      </label>
      <Button
        variant="secondary"
        className="self-start"
        disabled={!client || usage?.files === 0}
        onClick={() =>
          void client?.clearCache().then((freed) => {
            forgetUrls();
            setNotice(`Freed ${formatSize(freed)}. Your messages are all still here.`);
            refresh();
          })
        }
      >
        Clear cache
      </Button>
      {notice && <Alert tone="success">{notice}</Alert>}
    </Card>
  );
}
