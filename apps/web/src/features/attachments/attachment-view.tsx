// An attachment inside a web chat bubble. Files on the web arrive in Phase 18; until then the
// bubble says what the file is and where to open it.
import { formatSize } from '@pingdost/attachments';
import { attachmentType } from '@pingdost/chat-core';
import type { MessageRecord } from '@pingdost/message-engine';

export function AttachmentView({ message }: { message: MessageRecord }) {
  const { icon, name } = attachmentType(message);
  const size = message.attachment ? formatSize(message.attachment.plaintextSize) : '';
  return (
    <span className="block">
      {icon} {name} · {size}
      <span className="block text-xs opacity-80">Open it on your phone.</span>
    </span>
  );
}
