import { vi } from "vitest";

export const invoke = vi.fn().mockResolvedValue(undefined);
export const convertFileSrc = vi.fn((path: string) => path);
