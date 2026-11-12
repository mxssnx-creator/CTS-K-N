import {clientOrderSystemTypePrefix,isConnectionOwnedClientOrderId,clientOrderTypeOf} from "@/lib/system-order-ownership";
test("CTS-K-N typed identities exclude other projects and connections",()=>{
 for(const connection of ["bingx-x01","bingx-x02"]){
  for(const kind of ["main","preset","signal","direct","bot"] as const){
   const id=clientOrderSystemTypePrefix(connection,kind)+"nonce123";
   expect(isConnectionOwnedClientOrderId(id,connection)).toBe(true);
   expect(clientOrderTypeOf(id,connection)).toBe(kind);
   expect(isConnectionOwnedClientOrderId(id,connection==="bingx-x01"?"bingx-x02":"bingx-x01")).toBe(false);
  }
  for(const foreign of ["CTSAV2_E1","CTSBV2_E1","CTSXV2_E1","ctsc_abcd","Gx02abc"])
   expect(isConnectionOwnedClientOrderId(foreign,connection)).toBe(false);
 }
});
