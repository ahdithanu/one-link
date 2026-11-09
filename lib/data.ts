import { cache } from "react";
import rolesFile from "@/data/roles.json";
import briefsFile from "@/data/briefs.json";
import { loadBoard } from "./store";

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
  open?: boolean;
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

export type Board = { asOf: string; roles: Role[]; briefs: Record<string, Brief>; skipped: string[] };

export type RoleListing = Role & { buildTitle: string };

// Built into the deploy. The daily refresh replaces it once it has run.
export const bundled: Board = {
  asOf: rolesFile.asOf,
  roles: rolesFile.roles as unknown as Role[],
  briefs: briefsFile as Record<string, Brief>,
  skipped: [],
};

const DAY = 24 * 60 * 60 * 1000;

export const getBoard = cache(async (): Promise<Board> => {
  const board = (await loadBoard().catch(() => null)) ?? bundled;
  const now = Date.now();
  return {
    ...board,
    roles: board.roles.map((r) => ({ ...r, ageDays: r.posted ? Math.floor((now - Date.parse(r.posted)) / DAY) : r.ageDays })),
  };
});

export async function getOpenRoles() {
  const board = await getBoard();
  return board.roles.filter((r) => r.open !== false && board.briefs[r.id]);
}

export async function getListings(): Promise<RoleListing[]> {
  const board = await getBoard();
  return (await getOpenRoles()).map((r) => ({ ...r, buildTitle: board.briefs[r.id].build.title }));
}

export async function findRole(short: string) {
  if (!/^[0-9a-f]{8}$/.test(short)) return null;
  const board = await getBoard();
  const role = board.roles.find((r) => r.short === short);
  return role && board.briefs[role.id] ? { role, brief: board.briefs[role.id] } : null;
}
