// Area groups for price samples (07 "기준 표본 R"). Matching has no area filter: region is location
// information, not a condition (owner decision 2026-10-24). Pure.
import type { Area } from "../../domain";

export type RegionGroup = "gangnam_sinsa" | "myeongdong" | "hongdae" | "other";

const GROUP: Record<Area, RegionGroup> = {
  gangnam: "gangnam_sinsa",
  sinsa: "gangnam_sinsa",
  apgujeong: "gangnam_sinsa",
  myeongdong: "myeongdong",
  hongdae: "hongdae",
  other: "other",
};

export const regionGroupOf = (area: Area): RegionGroup => GROUP[area];

export const areasInGroup = (group: RegionGroup): Area[] => (Object.keys(GROUP) as Area[]).filter((a) => GROUP[a] === group);
