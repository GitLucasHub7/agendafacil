const test = require('node:test');
const assert = require('node:assert/strict');
const { world, authFor } = require('../helpers/world');
const { FieldValue } = require('../helpers/fakeFirestore');
const { withManualCheckout, PREFIX } = require('../../functions/payments/manualCheckout');
const { makeCreateSubscription, makeEngine, makeWebhook, makeReconcile } = require('../../functions/lib/subscriptions');
function setup() {
  const w = world(); const records = new Map(); const prefs = new Map(); const calls = []; let seq = 0;
  class MercadoPagoConfig {}
  class Preference {
    async create({body}) { const p = {...body,id:'pref'+(++seq),init_point:'https://www.mercadopago.com.br/checkout/v1?pref_id='+seq}; prefs.set(p.id,p); calls.push(body); return p; }
    async update({id,updatePreferenceRequest}) { Object.assign(prefs.get(id),updatePreferenceRequest); return prefs.get(id); }
    async search() { return { elements:[...prefs.values()], total:prefs.size }; }
    async get({preferenceId}) { return prefs.get(preferenceId); }
  }
  class Payment {
    async get({id}) { return records.get(String(id)); }
    async search({options}) { const list=[...records.values()].filter(p=>p.external_reference===options.external_reference);return {results:list.slice(options.offset,options.offset+50),paging:{total:list.length}}; }
    async cancel({id}) { records.get(String(id)).status='cancelled'; return records.get(String(id)); }
  }
  const recurring={...w.gw.provider,getPayment:async id=>{const p=records.get(String(id));return p?{id:String(p.id),status:p.status,amountCents:Math.round(p.transaction_amount*100),currency:p.currency_id}:w.gw.provider.getPayment(id);}};
  const provider=withManualCheckout({recurring,db:w.db,accessToken:'FAKE',environment:'test',now:w.clock.now,sdk:{MercadoPagoConfig,Preference,Payment}});
  const deps={db:w.db,FieldValue,getProvider:()=>provider,now:w.clock.now};
  const engine=makeEngine(deps);
  const create=makeCreateSubscription({...deps,getAppBaseUrl:()=> 'https://example.web.app'});
  const webhook=makeWebhook({...deps,engine,getSecret:()=>w.SECRET});
  const pay=(id,status='approved',extra={})=>records.set(String(id),{id:String(id),status,external_reference:PREFIX+api.subId,transaction_amount:21.9,currency_id:'BRL',live_mode:false,...extra});
  const api={w,records,prefs,calls,provider,engine,create,pay,webhook,reconcile:makeReconcile({...deps,engine})};
  api.start=async()=>{api.siteId=await w.newSite('alice','Pagamento Manual');const r=await create({auth:authFor('alice'),data:{siteId:api.siteId,billingMode:'manual',amount:1}});api.subId=r.subscriptionId;return r;};
  return api;
}
test('checkout manual usa preço do servidor, reaproveita pendência e bloqueia duplicação concorrente',async()=>{
 const a=setup();await a.start();await Promise.all([1,2].map(()=>a.create({auth:authFor('alice'),data:{siteId:a.siteId,billingMode:'manual'}})));
 assert.equal(a.calls.length,1);assert.equal(a.calls[0].items[0].unit_price,21.9);assert.equal(a.calls[0].auto_return,'approved');assert.equal(a.calls[0].external_reference,PREFIX+a.subId);assert.equal(a.calls[0].payment_methods.excluded_payment_types,undefined);
 assert.equal(a.w.siteDoc(a.siteId).published,false);
});
test('boleto pendente não publica; confirmação credita uma vez; estorno revoga publicação',async()=>{
 const a=setup();await a.start();a.pay('101','pending');await a.w.hook('payment','101',{handler:a.webhook});assert.equal(a.w.siteDoc(a.siteId).published,false);
 a.pay('101');assert.equal((await a.w.hook('payment','101',{handler:a.webhook})).code,200);assert.equal(a.w.siteDoc(a.siteId).published,true);const end=a.w.sub(a.subId).accessUntil;
 await a.w.hook('payment','101',{handler:a.webhook});assert.equal(a.w.sub(a.subId).accessUntil,end);assert.equal(a.w.invoices(a.subId).length,1);
 a.pay('101','refunded');await a.w.hook('payment','101',{handler:a.webhook});assert.equal(a.w.siteDoc(a.siteId).published,false);assert.equal(a.w.sub(a.subId).statusReason,'refund');
});
test('Pix confirmado vence sem carência e renovação preserva o histórico',async()=>{
 const a=setup();await a.start();a.pay('102');await a.engine.syncFromGateway(a.subId);const end=a.w.sub(a.subId).accessUntil;
 await assert.rejects(a.create({auth:authFor('alice'),data:{siteId:a.siteId,billingMode:'recurring'}}),e=>e.code==='failed-precondition');
 a.w.clock.set(end+1);await a.reconcile();assert.equal(a.w.siteDoc(a.siteId).published,false);assert.equal(a.w.sub(a.subId).statusReason,'manual_expired');
 const r=await a.create({auth:authFor('alice'),data:{siteId:a.siteId,billingMode:'manual'}});assert.equal(r.subscriptionId,a.subId);assert.equal(a.calls.length,2);
 a.pay('103');await a.engine.syncFromGateway(a.subId);assert.equal(a.w.siteDoc(a.siteId).published,true);assert.equal(a.w.invoices(a.subId).length,2);
});
test('pagamento de ambiente incorreto, moeda ausente e valor adulterado nunca liberam acesso',async()=>{
 for(const extra of [{live_mode:true},{currency_id:null},{transaction_amount:0.01}]){
 const a=setup();await a.start();a.pay('104','approved',extra);await a.w.hook('payment','104',{handler:a.webhook});assert.equal(a.w.siteDoc(a.siteId).published,false);
 }
});
test('recupera preferência persistida no gateway após falha de persistência local',async()=>{
 const a=setup();await a.start();await a.w.db.collection('subscriptions').doc(a.subId).update({manualCheckoutUrl:null});
 const r=await a.provider.findPreapprovalByExternalReference({externalReference:a.subId});assert.match(r.initPoint,/mercadopago/);assert.equal(a.calls.length,1);
});
test('troca de método verifica pagamento anterior antes de criar nova cobrança',async()=>{
 const a=setup();await a.start();a.pay('105');await assert.rejects(a.create({auth:authFor('alice'),data:{siteId:a.siteId,billingMode:'recurring'}}),e=>e.code==='failed-precondition');assert.equal(a.calls.length,1);assert.equal(a.w.siteDoc(a.siteId).published,true);
});
