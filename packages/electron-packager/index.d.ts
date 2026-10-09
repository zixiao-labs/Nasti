export interface PackOptions {
  input: string;
  output: string;
  unpack?: string[];
}

/** Pack a staged app; rejects on invalid input or existing output/sidecar. */
export function pack(options: PackOptions): Promise<void>;
