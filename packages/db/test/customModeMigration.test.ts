import { expect, it } from "vitest";
import { openRaw, readMigrations } from "../src/index.js";
import { migrate, packagedMigrationsDir } from "../src/migrate.js";

it("widens session mode without deleting history or changing foreign keys", () => {
  const db = openRaw(":memory:");
  try {
    const migrations = readMigrations(packagedMigrationsDir());
    migrate(db, migrations.filter((migration) => Number(migration.id.slice(0, 4)) <= 12));
    db.exec(`INSERT INTO projects(id,path,name,created_at,updated_at) VALUES ('p','C:/fixture','fixture',1,1);
      INSERT INTO sessions(id,project_id,mode,created_at,updated_at) VALUES ('s','p','round-table',1,1);
      INSERT INTO agents(id,session_id,name,backend,model,created_at) VALUES ('a','s','agent','codex','fixture',1);
      INSERT INTO turns(id,session_id,agent_id,role,created_at) VALUES ('t','s','a','agent',1);
      INSERT INTO blocks(id,turn_id,session_id,kind,block_index,payload_json,created_at,updated_at)
      VALUES ('b','t','s','text',0,'{}',1,1);`);
    migrate(db, migrations);
    expect(db.get<{ mode: string }>("SELECT mode FROM sessions WHERE id='s'")?.mode).toBe("round-table");
    db.run("UPDATE sessions SET mode='custom' WHERE id='s'");
    expect(db.get<{ mode: string }>("SELECT mode FROM sessions WHERE id='s'")?.mode).toBe("custom");
    expect(db.get("SELECT id FROM blocks WHERE id='b'")).toBeDefined();
    expect(db.get("SELECT agent_id FROM turns WHERE id='t'")).toMatchObject({ agent_id: "a" });
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => db.run("UPDATE sessions SET mode='arbitrary' WHERE id='s'")).toThrow();
  } finally { db.close(); }
});
