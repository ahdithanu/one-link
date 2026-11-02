import rolesFile from "@/data/roles.json";
import briefsFile from "@/data/briefs.json";

export type Pay =
  | { kind: "posted"; min: number; max: number }
  | { kind: "estimate"; function: string; p25: number; median: number; p75: number };

export type Role = {
  id: string;
  short: string;
  title: string;
  company: string;
  location: string | null;
  workplace: string | null;
  function: string;
  url: string;
  posted: string;
  ageDays: number;
  pay: Pay;
  conflict: string | null;
};

export type Brief = {
  need: string;
  evidence: string;
  build: { title: string; pitch: string };
  plan: { when: string; do: string }[];
  good: string[];
  avoid: string;
  opener: string;
};

export type RoleListing = Role & { buildTitle: string };

const briefs = briefsFile as Record<string, Brief>;
const allRoles = rolesFile.roles as unknown as Role[];

export const roles = allRoles.filter((r) => briefs[r.id]);

export const listings: RoleListing[] = roles.map((r) => ({ ...r, buildTitle: briefs[r.id].build.title }));

export function findRole(short: string) {
  const role = roles.find((r) => r.short === short);
  return role ? { role, brief: briefs[role.id] } : null;
}
