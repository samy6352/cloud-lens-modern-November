"""Resource explorer filtering and money semantics without Azure or PostgreSQL."""
import subprocess

from tests.test_dashboard_frontend import ROOT, node


def test_resource_filters_summary_and_unknowns():
    script = r"""
import assert from "node:assert/strict";
import {filterResources,resourceFacets,resourceSummary,resourceChange,createTabs}
  from "./web/assets/dashboard-resources.js";
const rows=[
  {id:"/sub/a",name:"API <test>",service:"Compute",subscription_id:"one",resource_group:"Prod",
    currency:"USD",cost:20,prior_cost:10,tags:[{key:"owner",value:"Alice"}],region:"eastus"},
  {id:"/SUB/A",name:"API <test>",service:"compute",subscription_id:"one",resource_group:"prod",
    currency:"EUR",cost:5,prior_cost:0,tags:[]},
  {id:"/sub/b",name:"Disk",service:"Storage",subscription_id:"two",resource_group:"Prod",
    currency:"USD",cost:-3,prior_cost:10,tags:[]},
  {id:"/sub/c",name:"Idle",service:"",subscription_id:"one",currency:"USD",cost:0,prior_cost:4},
  {id:"/sub/d",name:"Unobserved",currency:null,cost:null,prior_cost:null},
];
assert.equal(filterResources(rows,{query:"  ALICE "}).length,1);
assert.equal(filterResources(rows,{query:"<test>"}).length,2);
assert.equal(filterResources(rows,{query:"/sub/a"}).length,2);
assert.equal(filterResources(rows,{service:"value:compute"}).length,2);
assert.equal(filterResources(rows,{service:"missing"}).length,2);
assert.equal(filterResources(rows,{currency:"value:usd",change:"decreased"}).length,2);
assert.equal(filterResources(rows,{tags:"recorded"}).length,1);
assert.equal(filterResources(rows,{tags:"missing"}).length,4);
assert.equal(filterResources(rows,{query:"impossible"}).length,0);
assert.equal(resourceFacets(rows,"service").length,3);
assert.equal(resourceFacets(rows,"currency").length,3);
assert.equal(resourceChange(rows[0]),"increased");
assert.equal(resourceChange(rows[1]),"no-baseline");
assert.equal(resourceChange(rows[3]),"decreased");
assert.equal(resourceChange(rows[4]),"unavailable");
assert.equal(resourceChange({cost:0,prior_cost:0}),"no-baseline");
assert.equal(resourceChange({cost:10,prior_cost:10}),"unchanged");
assert.equal(resourceChange({cost:0.03,prior_cost:0.02}),"increased");
assert.equal(resourceChange({cost:0.02,prior_cost:0.03}),"decreased");
assert.equal(resourceChange({cost:1.005,prior_cost:1}),"increased");
assert.equal(resourceChange({cost:-1.005,prior_cost:-1}),"decreased");
assert.equal(resourceChange({cost:1,prior_cost:0.004}),"no-baseline");
const summary=resourceSummary(rows);
assert.equal(summary.resources,4,"one resource can have multiple currency rows");
assert.equal(summary.groups,2,"same group name in separate subscriptions is not one group");
assert.equal(summary.services,2);
assert.deepEqual(summary.costs.map(({currency,amount})=>({currency,amount})),
  [{currency:"EUR",amount:5},{currency:"UNKNOWN",amount:null},{currency:"USD",amount:17}]);
const partial=resourceSummary([{id:"a",currency:"USD",cost:10},{id:"b",currency:"USD",cost:null}]);
assert.equal(partial.costs[0].amount,10); assert.equal(partial.costs[0].missing,1);
assert.equal(resourceSummary([]).costs.length,0);
let painted=false;
const tabs=createTabs({loadToken:2,cached:async(k,fetcher)=>fetcher(),key:x=>x,qs:()=>"",
  get:async()=>({resources:[]}),setContent:()=>{painted=true}});
await tabs.renderResources(1);
assert.equal(painted,false,"a stale response cannot paint another scope");
const invalid=createTabs({loadToken:1,cached:async(k,fetcher)=>fetcher(),key:x=>x,qs:()=>"",get:async()=>({})});
await assert.rejects(()=>invalid.renderResources(1),/unavailable or incomplete/);
"""
    result = subprocess.run([node(), "--input-type=module", "-e", script], cwd=ROOT,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_server_requests_resets_cache_global_scope_and_cancellation():
    script = r"""
import assert from "node:assert/strict";
import {createTabs} from "./web/assets/dashboard-resources.js";
globalThis.document={activeElement:null};
const controls=["service","tags","currency","change"].map(field=>({
  dataset:{resourceFilter:field},value:"",focus(){},
}));
const elements=new Map();
for(const id of ["resourceSearch","resourceClear","resourceSummary","resourceResultCount",
  "resourceResults","resourceRequestStatus"]) elements.set("#"+id,{
    value:"",textContent:"",html:"",focus(){},insertAdjacentHTML(){},
    querySelectorAll(){return []},
  });
const root={isConnected:true,querySelector:id=>elements.get(id),contains:()=>false,
  querySelectorAll:selector=>selector==="[data-resource-filter]"?controls:[],
  setAttribute(){},scrollTop:0,scrollLeft:0};
let shown=false, token=1, globalQuery="?days=30&scope=one&currency=USD&region=eastus";
const body={}, requests=[], cache=new Map();
let server, delay=null;
const ctx={
  $:id=>id==="tabBody"?body:shown?root:null, esc:String,
  get loadToken(){return token},qs:()=>globalQuery,key:id=>id+"|"+globalQuery,
  cached:async(key,fetcher)=>{
    if(!cache.has(key)) cache.set(key,Promise.resolve().then(fetcher).catch(error=>{cache.delete(key);throw error}));
    return cache.get(key);
  },
  get:async(url,options)=>{
    requests.push({params:new URL(url,"http://localhost").searchParams,signal:options.signal,url});
    if(delay) await delay;
    return {resources:[{id:"/vm/one",name:"one",currency:"USD",cost:5,prior_cost:1}],
      page:Number(new URL(url,"http://localhost").searchParams.get("page")),
      pages:5,total:100,resources_by_currency:{USD:100},total_cost_by_currency:{USD:10000}};
  },
  setContent:(element,html)=>{if(element===body) shown=true;else element.html=html},
  kpiRow:values=>JSON.stringify(values),moneyHtml:value=>String(value),
  portalLinkMarkup:(row,scope,label)=>label,portalScopeIds:()=>[],
  table:(title,rows,columns,note,options)=>{server=options.server;return "table"},
  wireTables(){},
};
const tabs=createTabs(ctx);
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
await tabs.renderResources(token);
assert.equal(requests[0].params.get("page"),"1");
assert.equal(requests[0].params.get("page_size"),"20");
assert.equal(requests[0].params.get("scope"),"one");
assert.equal(requests[0].params.get("region"),"eastus");
assert.equal(requests[0].params.get("currency"),"USD");
assert.equal(requests[0].params.get("sort"),"cost");
assert.equal(requests[0].params.get("order"),"desc");
assert.ok(elements.get("#resourceSummary").html.includes("10000"),"totals use all matches");
assert.ok(elements.get("#resourceSummary").html.includes("on this page only"));
server.onChange({page:2}); await tick();
assert.equal(requests.at(-1).params.get("page"),"2");
server.onChange({page:1,sort:"delta",descending:false}); await tick();
assert.equal(requests.at(-1).params.get("sort"),"delta");
assert.equal(requests.at(-1).params.get("order"),"asc");
server.onChange({page:2}); await tick();
const search=elements.get("#resourceSearch");
search.oninput({target:{value:"/vm/search"}}); await new Promise(resolve=>setTimeout(resolve,280));
assert.equal(requests.at(-1).params.get("q"),"/vm/search");
assert.equal(requests.at(-1).params.get("page"),"1");
const currency=controls.find(control=>control.dataset.resourceFilter==="currency");
currency.value="value:eur"; currency.onchange(); await tick();
assert.equal(requests.at(-1).params.get("billing_currency"),"eur");
const change=controls.find(control=>control.dataset.resourceFilter==="change");
change.value="increased"; change.onchange(); await tick();
assert.equal(requests.at(-1).params.get("change"),"increased");
assert.equal(requests.at(-1).params.get("page"),"1");
const count=requests.length;
const tags=controls.find(control=>control.dataset.resourceFilter==="tags");
tags.value="recorded"; tags.onchange();
assert.equal(requests.length,count,"page-only tags never masquerade as a server filter");
assert.ok(elements.get("#resourceResultCount").textContent.includes("100 matching"));
tags.value="";tags.onchange();
tabs.stop(); token=2; tabs.resume(token); await tick();
assert.equal(requests.length,count,"completed cached navigation does not fetch");
cache.clear();
elements.get("#resourceClear").onclick(); await tick();
assert.equal(requests.at(-1).params.get("q"),"");
assert.equal(requests.at(-1).params.get("billing_currency"),"");
assert.equal(requests.at(-1).params.get("change"),"");
assert.equal(requests.at(-1).params.get("page"),"1");
let release;delay=new Promise(resolve=>{release=resolve});
server.onChange({page:3});await tick();
const stale=requests.at(-1);
search.oninput({target:{value:"latest"}});
assert.equal(stale.signal.aborted,true,"input cancels before the debounce finishes");
release();delay=null;await tick();
assert.ok(elements.get("#resourceResultCount").textContent.includes("Page 1"),"late cancelled page cannot paint");
await new Promise(resolve=>setTimeout(resolve,280));
assert.equal(requests.at(-1).params.get("q"),"latest");
tabs.stop();token=3;globalQuery="?days=7&scope=two&currency=EUR&service=Compute";
shown=false;
const other=createTabs(ctx);await other.renderResources(token);
assert.equal(requests.at(-1).params.get("page"),"1");
assert.equal(requests.at(-1).params.get("days"),"7");
assert.equal(requests.at(-1).params.get("scope"),"two");
assert.equal(requests.at(-1).params.get("service"),"Compute");
assert.equal(requests.at(-1).params.get("q"),"");
let releaseScope;delay=new Promise(resolve=>{releaseScope=resolve});
server.onChange({page:4});await tick();const old=requests.at(-1);
other.stop();token++;releaseScope();delay=null;await tick();
assert.equal(old.signal.aborted,true,"global scope/tab departure aborts the read");
assert.ok(!elements.get("#resourceResultCount").textContent.includes("Page 4"));
"""
    result = subprocess.run([node(), "--input-type=module", "-e", script], cwd=ROOT,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
