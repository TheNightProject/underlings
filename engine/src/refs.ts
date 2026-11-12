import * as shared from '../../lib/refs.mjs';

export type Provider = 'gitlab' | 'github';

export interface MrRef {
  provider?: Provider;
  projectPath: string;
  iid: number;
}

type Numbered = Pick<MrRef, 'provider' | 'iid'>;

export const keyOf: (ref: MrRef) => string = shared.keyOf;
export const idKey: (ref: { provider?: Provider; projectId: number; iid: number | string | null }) => string = shared.idKey;
export const isKey: (key: unknown) => boolean = shared.isKey;
export const keyParts = shared.keyParts as (key: unknown) => MrRef | null;
export const keyPath: (key: string | undefined) => string | null = shared.keyPath;
export const refNumber: (ref: string | Numbered) => string = shared.refNumber;
export const shortKey: (key: string) => string = shared.shortKey;
export const keysInText: (text: string) => string[] = shared.keysInText;
