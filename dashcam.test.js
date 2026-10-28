const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {autenticar,montar,validarRegistro,digest}=require('./dashcam');
const env={DASHCAM_DEVICE_TOKEN:'device-unit-test-'.repeat(3),DASHCAM_OWNER_TOKEN:'owner-unit-test-'.repeat(3),DASHCAM_DEVICE_ID:'unidad-prueba'};

test('acceso cerrado si faltan credenciales separadas',()=>{
 assert.throws(()=>autenticar({}));
 assert.throws(()=>autenticar({...env,DASHCAM_OWNER_TOKEN:env.DASHCAM_DEVICE_TOKEN}));
});
test('checksum se valida sobre bytes UTF-8, sin alterar contenido',()=>{
 const texto=JSON.stringify({nota:'sin posición',valor:9.8}),id=randomUUID();
 const r={id,recorrido_id:id,tipo:'muestra',contenido_json:texto,sha256:digest(texto)};
 assert.equal(validarRegistro(r,'prueba').contenido.nota,'sin posición');
 assert.throws(()=>validarRegistro({...r,contenido_json:texto+' '},'prueba'));
});
test('API autentica roles, reintenta sin duplicar y rechaza conflictos',async t=>{
 const registros=new Map(),videos=new Map();
 const fake={from(){return {
   insert(f){if(registros.has(f.id))return Promise.resolve({error:{code:'23505'}});registros.set(f.id,f);return Promise.resolve({error:null});},
   select(){return {eq(k,id){return {single:async()=>({data:registros.get(id),error:null})};}};}
  };}, storage:{from(){return {
   upload:async(path,bytes)=>{if(videos.has(path))return {error:{message:'exists'}};videos.set(path,Buffer.from(bytes));return {error:null};},
   download:async path=>({data:new Blob([videos.get(path)]),error:null})
  };}}};
 const app=express();app.use(express.json());app.use(autenticar(env));montar(app,fake);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port;
 const solicitud=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.equal((await solicitud('/dashcam/recorridos','mala')).status,401);
 assert.equal((await solicitud('/dashcam/recorridos',env.DASHCAM_DEVICE_TOKEN)).status,403);
 assert.equal((await solicitud('/dashcam/registros',env.DASHCAM_OWNER_TOKEN,'POST',{})).status,403);
 const id=randomUUID(),trip=randomUUID(),contenido_json=JSON.stringify({datos:{imu_valida:false,gps_valido:false}});
 const r={id,recorrido_id:trip,tipo:'muestra',contenido_json,sha256:digest(contenido_json)};
 for(let i=0;i<2;i++){const res=await solicitud('/dashcam/registros',env.DASHCAM_DEVICE_TOKEN,'POST',{registros:[r]});assert.equal(res.status,200);assert.equal((await res.json()).confirmados[0].sha256,r.sha256);}
 assert.equal(registros.size,1);
 const modificado=JSON.stringify({distinto:true});
 assert.equal((await solicitud('/dashcam/registros',env.DASHCAM_DEVICE_TOKEN,'POST',{registros:[{...r,contenido_json:modificado,sha256:digest(modificado)}]})).status,409);
 assert.equal(registros.get(id).contenido_sha256,r.sha256);
 const bytes=Buffer.from('segmento-sintetico'),v=randomUUID();
 const subir=b=>fetch(`${base}/dashcam/videos/${trip}/${v}`,{method:'PUT',headers:{Authorization:'Bearer '+env.DASHCAM_DEVICE_TOKEN,'Content-Type':'video/mp4','X-Content-Sha256':digest(b)},body:b});
 assert.equal((await subir(bytes)).status,200);assert.equal((await subir(bytes)).status,200);
 assert.equal(videos.size,1);assert.equal((await subir(Buffer.from('distinto'))).status,409);
});
