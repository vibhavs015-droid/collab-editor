import { RgaDocument } from "./src/core/crdt/rga.js";
import { mulberry32, randomInt, shuffle, pick } from "./src/core/crdt/rng.js";
const A = "abcdefghij .";
function run(seed, n) {
  const r = mulberry32(seed);
  const reps = Array.from({length:n},(_,i)=>new RgaDocument(`s${i}`));
  const produced = [];
  for (let round=0; round<randomInt(r,3,12); round++)
    for (let a=0;a<n;a++){
      const rep=reps[a]; const t=rep.toText();
      for (let e=0;e<randomInt(r,1,4);e++){
        if (r()<0.35 && t.length>0){
          const s=randomInt(r,0,t.length-1), L=randomInt(r,1,Math.min(4,t.length-s));
          for (const op of rep.deleteRange(s,L)) produced.push(op);
        } else {
          const off=randomInt(r,0,t.length); let v="";
          for(let k=0;k<randomInt(r,1,3);k++) v+=pick(A.split(""),r);
          for (const op of rep.insertAt(off,v)) produced.push(op);
        }
      }
      rep.applyInAnyOrder(shuffle(produced,r));
    }
  for (const rep of reps) rep.applyInAnyOrder(shuffle(produced,r));
  const t0=reps[0].toText();
  for (let i=1;i<reps.length;i++) if (reps[i].toText()!==t0) return seed;
  return null;
}
let bad=0, firstBad=null;
for (let s=1;s<=3000;s++){ const f=run(s,2+(s%3)); if(f!==null){bad++; if(firstBad===null)firstBad=f;} }
console.log("DIVERGED:", bad, "of 3000; first seed:", firstBad);
