import {coerceEffect} from './entry-save.mjs';

export const MANIFEST_LIMIT=16384;
export const MANIFEST_SCHEMA='iw-global-items-v1';
const TYPES=['food','weapon','tool','light','token','strange'];
function record(value,keys,path){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(path+'必须是 JSON 对象。');
 for(const key of Object.keys(value))if(!keys.includes(key))throw new Error(path+'不支持字段 '+key+'。请勿上传玩家血量、理智或整份存档。');
}
function text(value,max,path){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(path+'必须是 1–'+max+' 个字符的文字。');return value.trim();}
export function validateItemManifest(input){
 record(input,['schema','items'],'道具声明');
 if(input.schema!==MANIFEST_SCHEMA)throw new Error('schema 必须是 '+MANIFEST_SCHEMA+'，请下载声明模板。');
 if(!Array.isArray(input.items)||input.items.length>3)throw new Error('items 必须是最多 3 件全局道具的数组；没有全局道具时使用空声明模板，保留 items: []。关内专用道具不要填入。');
 const ids=new Set();
 const items=input.items.map((item,index)=>{
  const at='第 '+(index+1)+' 件道具';record(item,['id','name','type','desc','effect'],at);
  const id=text(item.id,64,at+' id');
  if(!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id))throw new Error(at+' id 必须以英文字母开头，只使用英文字母、数字、下划线或连字符。');
  if(ids.has(id))throw new Error(at+' id 重复，请为每件道具使用不同的 id。');ids.add(id);
  if(!TYPES.includes(item.type))throw new Error(at+' type 只能是 '+TYPES.join(' / ')+'。');
  record(item.effect,['stat','value','trigger'],at+' effect');
  const effect=coerceEffect(item.effect);
  if(!effect||effect.stat!==item.effect.stat||effect.trigger!==item.effect.trigger)throw new Error(at+' effect 不合规：hp 为 1 或 2；sanity、max_hp、attack 为 1；cleanse 为 true；trigger 为 on_enter 或 passive。');
  return {id,name:text(item.name,32,at+'名称'),type:item.type,desc:text(item.desc,120,at+'说明'),effect};
 });
 return {schema:MANIFEST_SCHEMA,items};
}
export function parseItemManifest(source){
 if(typeof source!=='string'||new TextEncoder().encode(source).length>MANIFEST_LIMIT)throw new Error('道具声明文件不能超过 16 KB。');
 let input;try{input=JSON.parse(source.replace(/^\uFEFF/,''));}catch{throw new Error('文件不是有效 JSON，请检查引号、逗号和括号，或重新下载模板。');}
 return validateItemManifest(input);
}
// 运行时只按已声明 ID 领取道具；效果来自审核过的声明，不采信游戏临时改写的数值。
export function declaredHandoffItems(items,inherited,manifest,{failure=false}={}){
 if(!Array.isArray(items))throw new Error('交接道具必须是数组。');
 const previous=new Map((inherited||[]).map(item=>[item.id,item]));
 const declared=new Map(manifest.items.map(item=>[item.id,item]));
 const seen=new Set(),result=[];
 for(const item of items){
  if(!item||typeof item.id!=='string')throw new Error('交接道具缺少 id。');
  const canonical=previous.get(item.id)||declared.get(item.id);
  if(!canonical){if(failure)continue;throw new Error('道具 '+item.id+' 未在全局道具声明中登记，不能跨关交接。');}
  if(seen.has(item.id))throw new Error('同一次交接不能重复领取道具 '+item.id+'。');
  seen.add(item.id);result.push({...canonical});
 }
 return result.slice(-3);
}
export function acquiredHandoffItems(ids,inherited,manifest){
 if(!Array.isArray(ids)||ids.length>3||ids.some(id=>typeof id!=='string'))throw new Error('acquiredItemIds 必须是最多 3 个道具 ID 的数组；没有获得道具时传空数组。');
 const declared=new Map(manifest.items.map(item=>[item.id,item]));
 for(const id of ids)if(!declared.has(id))throw new Error('道具 '+id+' 未在本关的全局道具声明中登记。');
 if(new Set(ids).size!==ids.length)throw new Error('同一次交接不能重复领取同一件道具。');
 // 先保留已有背包，再放入实际获得的物品；超过三件时沿用官方“保留最近三件”规则。
 const received=new Set(ids);
 return [...(inherited||[]).filter(item=>!received.has(item.id)),...ids.map(id=>({...declared.get(id)}))].slice(-3);
}
