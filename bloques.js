// MP4 finales de 5 minutos, sin recodificar. Partes privadas <50 MB para Free.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),crypto=require('node:crypto');
const ffmpeg=require('ffmpeg-static');
const SEGUNDOS=300,PARTE_BYTES=40_000_000;
const trabajos=new Map();let ocupado=false;
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function uuid(nombre){const h=digest(nombre);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
const coleccionId=(device,trip)=>uuid(`dashguard:coleccion:v1:${device}:${trip}:${SEGUNDOS}`);

function ejecutar(args){return new Promise((resolve,reject)=>{
 const p=spawn(ffmpeg,['-nostdin',...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});let salida='',error=false;
 const timer=setTimeout(()=>p.kill(),20*60*1000);
 p.stdout.on('data',d=>{if(salida.length<1_000_000)salida+=d.toString();});
 p.stderr.on('data',()=>{error=true;}); // No registrar URLs firmadas ni contenido privado.
 p.on('error',()=>{clearTimeout(timer);reject(Error('No se pudo iniciar FFmpeg'));});
 p.on('close',code=>{clearTimeout(timer);code===0&&!error?resolve(salida):reject(Error('FFmpeg no pudo verificar los bloques; fuentes conservadas'));});
});}
async function contarFrames(archivo){
 const salida=await ejecutar(['-v','error','-i',archivo,'-map','0:v:0','-c:v','copy','-f','framecrc','pipe:1']);
 const cantidad=(salida.match(/^0,/gm)||[]).length;
 if(!cantidad)throw Error('Sin conteo de paquetes de video');
 return cantidad;
}
async function agrupar(fuentes,carpeta,segundos=SEGUNDOS){
 if((await fsp.readdir(carpeta)).some(n=>/^bloque_\d+\.mp4$/.test(n)))throw Error('Destino con bloques existentes; no se sobrescribe');
 const lista=path.join(carpeta,'fuentes.ffconcat');
 await fsp.writeFile(lista,fuentes.map(f=>"file '"+f.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'\n").join(''),{mode:0o600});
 await ejecutar(['-v','error','-n','-protocol_whitelist','file,https,tls,tcp,crypto','-f','concat','-safe','0','-i',lista,
  '-map','0:v:0','-c:v','copy','-f','segment','-segment_time',String(segundos),'-reset_timestamps','1',
  '-segment_format','mp4','-segment_format_options','movflags=+faststart',path.join(carpeta,'bloque_%03d.mp4')]);
 const archivos=(await fsp.readdir(carpeta)).filter(n=>/^bloque_\d+\.mp4$/.test(n)).sort();
 const grupos=[];
 for(const nombre of archivos){const archivo=path.join(carpeta,nombre);grupos.push({archivo,frames:await contarFrames(archivo),bytes:(await fsp.stat(archivo)).size});}
 return grupos;
}
async function hashStream(stream){const hash=crypto.createHash('sha256');let bytes=0;for await(const b of stream){hash.update(b);bytes+=b.length;}return {sha256:hash.digest('hex'),bytes};}
async function hashRemoto(bucket,ruta){
 const r=await bucket.createSignedUrl(ruta,300);if(r.error)throw r.error;
 const data=await fetch(r.data.signedUrl,{signal:AbortSignal.timeout(120000)});
 if(!data.ok)throw Error('Objeto privado no verificable');return hashStream(data.body);
}
async function guardarRegistro(s,r){
 const {error}=await s.from('dashcam_registros').insert(r);
 if(!error)return;
 if(error.code!=='23505')throw error;
 const previo=await s.from('dashcam_registros').select('contenido_sha256,device_id,recorrido_id').eq('id',r.id).single();
 if(previo.error||['contenido_sha256','device_id','recorrido_id'].some(k=>previo.data[k]!==r[k]))throw Error('Conflicto de exportacion; no se sobrescribe');
}
async function registro(s,device,trip,id,contenido){
 await guardarRegistro(s,{id,device_id:device,recorrido_id:trip,tipo:'video',contenido,contenido_sha256:digest(JSON.stringify(contenido))});
}
async function existente(s,device,trip){
 const r=await s.from('dashcam_registros').select('contenido').eq('id',coleccionId(device,trip)).eq('device_id',device).maybeSingle();
 if(r.error)throw r.error;return r.data?.contenido;
}
async function procesar(s,device,trip){
 const etapa=valor=>trabajos.set(trip,{estado:'procesando',etapa:valor});etapa('consultar_fuentes');
 const bucket=s.storage.from('dashguard-videos');
 const r=await s.from('dashcam_registros').select('id,contenido').eq('device_id',device).eq('recorrido_id',trip).eq('tipo','video').limit(1000);
 if(r.error)throw r.error;
 const fuentes=r.data.filter(v=>!v.contenido.presentacion).sort((a,b)=>a.contenido.metadata.inicio_ns-b.contenido.metadata.inicio_ns);
 if(!fuentes.length)throw Error('No hay fuentes recibidas');
 const marcas=fuentes.flatMap(v=>v.contenido.metadata.sensor_timestamps_ns);
 etapa('configurar_bucket');const update=await s.storage.updateBucket('dashguard-videos',{public:false,fileSizeLimit:48_000_000,allowedMimeTypes:['video/mp4','application/octet-stream']});
 if(update.error)throw update.error;
 const links=await bucket.createSignedUrls(fuentes.map(v=>`${device}/${trip}/${v.id}.mp4`),3600);
 if(links.error||links.data.some(v=>!v.signedUrl||v.error))throw Error('No se pudieron autorizar las fuentes');
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'dashguard-bloques-'));
 try{
  etapa('ffmpeg');const grupos=await agrupar(links.data.map(v=>v.signedUrl),dir);
  if(grupos.reduce((n,g)=>n+g.frames,0)!==marcas.length)throw Error('No coincide el total de fotogramas');
  const ids=[];let offset=0;
  for(let i=0;i<grupos.length;i++){
   etapa('subir_bloque_'+(i+1));const g=grupos[i],id=uuid(`dashguard:bloque:v1:${device}:${trip}:${SEGUNDOS}:${i}`),partes=[];
   const completo=await hashStream(fs.createReadStream(g.archivo));
   for(let desde=0,n=0;desde<g.bytes;desde+=PARTE_BYTES,n++){
    const fin=Math.min(g.bytes,desde+PARTE_BYTES)-1;
    const hash=await hashStream(fs.createReadStream(g.archivo,{start:desde,end:fin}));
    const ruta=`${device}/${trip}/bloques-300-v1/${id}/parte_${String(n).padStart(3,'0')}.bin`;
    const subido=await bucket.upload(ruta,fs.createReadStream(g.archivo,{start:desde,end:fin}),
      {contentType:'application/octet-stream',upsert:false,headers:{'Content-Length':String(hash.bytes)}});
    // Confirmar tambien un reintento con objeto ya existente; nunca sobrescribir.
    const verificado=await hashRemoto(bucket,ruta);
    if(verificado.sha256!==hash.sha256||verificado.bytes!==hash.bytes)throw Error('No coincide la parte almacenada');
    if(subido.error&&!verificado.bytes)throw subido.error;
    partes.push({ruta,sha256:hash.sha256,bytes:hash.bytes});
   }
   const tiempos=marcas.slice(offset,offset+g.frames);
   await registro(s,device,trip,id,{presentacion:true,clase:'bloque',numero:i+1,total:grupos.length,
     segundos_solicitados:SEGUNDOS,frames:g.frames,bytes:g.bytes,sha256:completo.sha256,partes,
     metadata:{video_id:id,boot_id:fuentes[0].contenido.metadata.boot_id,inicio_ns:tiempos[0],
       fin_exclusivo_ns:marcas[offset+g.frames]||tiempos.at(-1)+1,sensor_timestamps_ns:tiempos,
       advertencia:'MP4 sin recodificar; PTS originales y sensores en los segmentos fuente'}});
   ids.push(id);offset+=g.frames;
   trabajos.set(trip,{estado:'procesando',bloques_listos:i+1,total:grupos.length});
  }
  await registro(s,device,trip,coleccionId(device,trip),{presentacion:true,clase:'coleccion',segundos:SEGUNDOS,
      bloques:ids,frames:marcas.length,fuentes:fuentes.map(v=>v.id),originales_conservados:true,recodificado:false});
  trabajos.set(trip,{estado:'completo',bloques_listos:ids.length,total:ids.length});
 }catch(e){e.etapa=trabajos.get(trip)?.etapa;throw e;}finally{
  // Solo directorio efimero creado aqui; nunca rutas recibidas del usuario.
  if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'dashguard-bloques-'))throw Error('Ruta temporal inesperada');
  await fsp.rm(dir,{recursive:true,force:true});
 }
}
async function lanzar(s,device,trip,reintentar=false){
 const listo=await existente(s,device,trip);if(listo)return {estado:'completo',total:listo.bloques.length};
 if(trabajos.has(trip)&&!reintentar)return trabajos.get(trip);
 trabajos.set(trip,{estado:'pendiente'});
 return {estado:'pendiente'};
}
async function atender(s,device){
 if(ocupado)return;
 const pendiente=[...trabajos.entries()].find(([,v])=>v.estado==='pendiente');if(!pendiente)return;
 ocupado=true;const [trip]=pendiente;trabajos.set(trip,{estado:'procesando'});
 try{await procesar(s,device,trip);}catch(e){trabajos.set(trip,{estado:'error',etapa:e.etapa||trabajos.get(trip)?.etapa,error:'No se completaron los bloques; fuentes conservadas. Puede reintentarse.'});}
 finally{ocupado=false;}
}
function montarBloques(app,s,device){
 app.post('/dashcam/recorridos/:id/exportar',async(req,res)=>{
  if(!/^[a-f0-9-]{36}$/.test(req.params.id))return res.status(400).json({error:'UUID invalido'});
  try{const fin=await s.from('dashcam_registros').select('id').eq('device_id',device).eq('recorrido_id',req.params.id).eq('tipo','fin').limit(1);
   if(fin.error||!fin.data.length)return res.status(409).json({error:'Esperar cierre y sincronizacion del recorrido'});
   const estado=await lanzar(s,device,req.params.id,true);res.status(202).json(estado);atender(s,device);
  }catch{res.status(502).json({error:'No se pudo iniciar la exportacion'});}
 });
 app.get('/dashcam/recorridos/:id/bloques',async(req,res)=>{
  try{const c=await existente(s,device,req.params.id);res.json(c?{estado:'completo',total:c.bloques.length,ids:c.bloques}:trabajos.get(req.params.id)||{estado:'pendiente'});}
  catch{res.status(502).json({error:'No se pudo consultar la exportacion'});}
 });
 // Recuperacion tras despliegue/reinicio. Solo recorridos cerrados y >=5 min.
 async function recuperar(){try{
  const r=await s.from('dashcam_registros').select('recorrido_id,contenido').eq('device_id',device).eq('tipo','fin').order('recibido_en',{ascending:false}).limit(100);
  if(r.error)return;
  for(const f of r.data){if(f.contenido.estado==='completo'&&f.contenido.fin_boottime_ns&&f.contenido.presentacion_origen!=='raspberry'){
    const ini=await s.from('dashcam_registros').select('contenido').eq('id',f.recorrido_id).maybeSingle();
    if(ini.data&&(f.contenido.fin_boottime_ns-ini.data.contenido.inicio_boottime_ns)/1e9>=SEGUNDOS)await lanzar(s,device,f.recorrido_id);
  }}await atender(s,device);
 }catch{ /* Reintentar sin afectar ingesta/consulta. */ }}
 const inicial=setTimeout(recuperar,2000);inicial.unref();
 const reloj=setInterval(recuperar,30000);reloj.unref();
 return {lanzar:trip=>lanzar(s,device,trip),estado:trip=>trabajos.get(trip)};
}
module.exports={agrupar,contarFrames,hashStream,uuid,coleccionId,montarBloques};

