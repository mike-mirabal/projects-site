// split.js
import fs from "fs";

// read your master .md file
const src = fs.readFileSync("./ghost_donkey_knowledge.md", "utf8");

// split into sections by headings
const sections = src.split(/\n(?=###[^\n]+)/g);

// guest = strip out [STAFF-*] blocks
const guest = sections.map(s =>
  s.replace(/\[STAFF[^\]]*\][\s\S]*?(?=(\n\[|$))/g, "")
   .replace(/\[GUEST\]\s*/g, "")
).join("\n").trim();

// staff = keep everything, but remove [GUEST] labels
const staff = sections.map(s =>
  s.replace(/\[GUEST\]\s*/g, "")
).join("\n").trim();

fs.writeFileSync("ghost_guest.md", guest);
fs.writeFileSync("ghost_staff.md", staff);
console.log("✓ ghost_guest.md + ghost_staff.md created");
