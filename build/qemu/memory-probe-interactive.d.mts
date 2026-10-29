export function interactiveMemoryProbeSequence(sequence: unknown, expectedSha256: string): {
  schema: "terrarium.interactive-guest-command-sequence/v1";
  artifactSha256: string;
  artifactBytes: number;
  binaryChunkBytes: number;
  commands: string[];
  commandBytes: number[];
  maximumCommandBytes: number;
  limitation: string;
};
