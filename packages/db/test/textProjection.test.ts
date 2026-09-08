import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { openStore } from "../src/index.js";

it("projects only text at the SQL boundary, preserving empty history markers, ordering and the latest peer words", () => {
  const store = openStore(":memory:", { migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)) });
  try {
    const project = store.projects.upsertByPath({ path: "C:\\owned-projection-fixture" });
    const {session,agents} = store.sessions.create({ projectId:project.id,mode:"round-table",agents:[
      {name:"lead",role:"lead",backend:"claude",model:"claude-sonnet-5",config:{}},
      {name:"peer",role:"member",backend:"codex",model:"gpt-5.6-luna",config:{}},
    ] });
    const first=store.turns.create({sessionId:session.id,role:"user"});
    const watermark=store.turns.create({sessionId:session.id,agentId:agents[0]!.id,role:"agent"});
    const peer=store.turns.create({sessionId:session.id,agentId:agents[1]!.id,role:"agent",speakerLabel:"@peer"});
    const streaming=store.turns.create({sessionId:session.id,agentId:agents[0]!.id,role:"agent",status:"streaming"});
    store.db.run("UPDATE turns SET created_at = 1 WHERE session_id = ?",session.id);
    let id=0;
    function block(turn:string,kind:string,payload:unknown,index=0) {
      store.db.run("INSERT INTO blocks(id,turn_id,session_id,kind,block_index,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)",`b${++id}`,turn,session.id,kind,index,JSON.stringify(payload));
    }
    block(first.id,"text",{text:"initial request"});
    block(watermark.id,"tool_call",{output:"SECRET_TOOL_PAYLOAD".repeat(200000)});
    block(peer.id,"text",{text:"second"},1);
    block(peer.id,"text",{text:"latest peer note"},0);
    block(peer.id,"text",{text:"delegated words",delegatedFrom:"child"},2);
    block(streaming.id,"text",{text:"unfinished"});
    const query=vi.spyOn(store.db,"all");
    expect(store.blocks.textEntries(session.id)).toEqual([
      {id:first.id,agentId:null,role:"user",text:"initial request"},
      {id:watermark.id,agentId:agents[0]!.id,role:"agent",text:""},
      {id:peer.id,agentId:agents[1]!.id,role:"agent",speakerLabel:"@peer",text:"latest peer note\nsecond"},
    ]);
    const sql=String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("b.kind = 'text'");
    expect(sql).not.toMatch(/SELECT\s+(?:b\.)?\*/i);
    // Crucially, inspect the rows returned by SQLite, not only the final filtered result.
    expect(JSON.stringify(query.mock.results[0]?.value)).not.toContain("SECRET_TOOL_PAYLOAD");
    expect(Buffer.byteLength(JSON.stringify(query.mock.results[0]?.value))).toBeLessThan(1500);
    expect(store.blocks.textOfTurn(peer.id)).toBe("latest peer note\nsecond");
  } finally { store.close(); }
});
