import { cache } from "react";
import rolesFile from "@/data/roles.json";
import briefsFile from "@/data/briefs.json";
import { loadBoard } from "./store";

export type Pay =
  | { kind: "posted"; min: number; max: number }
  | { kind: "estimate"; function: string; p25: number; median: number; p75: number }
  // Network roles outside speedrun: the speedrun pay bands don't describe them.
  | { kind: "unposted" };

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

async function readBoard(): Promise<Board> {
  const board = (await loadBoard().catch(() => null)) ?? bundled;
  const now = Date.now();
  return {
    ...board,
    roles: board.roles.map((r) => ({ ...r, ageDays: r.posted ? Math.floor((now - Date.parse(r.posted)) / DAY) : r.ageDays })),
  };
}

// Pages read the board fresh (once per render), so a page rebuilt right after the daily refresh sees it.
export const getBoard = cache(readBoard);

// The MCP server reads it at most once a minute per instance. The board changes once a day, and a
// Blob read on every tool call was most of the tool latency in production.
const BOARD_TTL_MS = 60_000;
let memo: { at: number; board: Promise<Board> } | null = null;
export function getBoardCached(now = Date.now()): Promise<Board> {
  if (!memo || now - memo.at > BOARD_TTL_MS || now < memo.at) {
    const board = readBoard();
    memo = { at: now, board };
    board.catch(() => (memo = null));
  }
  return memo.board;
}

type Loader = () => Promise<Board>;

export async function getOpenRoles(load: Loader = getBoard) {
  const board = await load();
  return board.roles.filter((r) => r.open !== false && board.briefs[r.id]);
}

export async function getListings(load: Loader = getBoard): Promise<RoleListing[]> {
  const board = await load();
  return (await getOpenRoles(() => Promise.resolve(board))).map((r) => ({ ...r, buildTitle: board.briefs[r.id].build.title }));
}

export async function findRole(short: string, load: Loader = getBoard) {
  if (!/^[0-9a-f]{8}$/.test(short)) return null;
  const board = await load();
  const role = board.roles.find((r) => r.short === short);
  return role && board.briefs[role.id] ? { role, brief: board.briefs[role.id] } : null;
}
