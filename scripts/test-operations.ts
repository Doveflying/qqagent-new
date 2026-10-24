import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeFixture} from './helpers/chat-fixture.js';
import {redactLog} from '../src/core/logger.js';
import {ProviderManager} from '../src/llm/manager.js';
test('退出等待活跃回复取消，之后拒绝准入',async()=>{
 const f=makeFixture({name:'shutdown',expectedProvider:'default'},'private:1');
 try {
  const running=f.pipeline.handle(f.msg,f.api);
  assert.equal(await f.pipeline.shutdown(1000),true);await running;
  assert.equal(f.sends(),0);assert.equal((await f.pipeline.handle({...f.msg,messageId:99},f.api)).replied,false);
 }finally{f.store.close();}
});
test('日志隐藏深层密钥、完整 URL 与图片数据',()=>{
 const log=redactLog({headers:{Authorization:'secret'},apiKey:'key',url:'https://host/image?token=secret',image:'base64://QUJD'});
 assert.ok(!JSON.stringify(log).includes('secret'));assert.ok(!JSON.stringify(log).includes('QUJD'));
});
test('统计落库并可从新管理器恢复，包含用途与失败',()=>{
 const f=makeFixture({name:'usage',expectedProvider:'default'},'private:1');
 try {
  const manager:any=Object.create(ProviderManager.prototype);manager.usage=new Map();manager.attachUsageStore(f.store.db);
  manager.recordUsage('p','m',{latencyMs:20,usage:{promptTokens:5,completionTokens:3}},'facts',1);
  manager.metric({provider:'p',model:'m',purpose:'facts',success:false,latencyMs:10,retry:2,error:'HTTP 429 rate limit',errorKind:'rate_limit',chainId:'c1'});
  const restored:any=Object.create(ProviderManager.prototype);restored.usage=new Map();restored.attachUsageStore(f.store.db);assert.equal(restored.getUsage()[0].promptTokens,5);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as any).n,2);
  // 失败行要带上分类和调用链，否则调用诊断面板什么都看不到
  const failed=(f.store.db.prepare("SELECT purpose,error_kind,chain_id,error FROM llm_calls WHERE success=0").get() as any);
  assert.equal(failed.purpose,'facts');assert.equal(failed.error_kind,'rate_limit');assert.equal(failed.chain_id,'c1');assert.match(failed.error,/429/);
 }finally{f.store.close();}
});
