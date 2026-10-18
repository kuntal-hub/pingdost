import { z } from 'zod';

import { CursorSchema } from './common';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Query string of a paginated GET: `?cursor=…&limit=…`. */
export const PageQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

/** A page of results; `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({ items: z.array(item), nextCursor: CursorSchema.nullable() });
}
