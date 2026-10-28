const crypto = require('node:crypto');
const express = require('express');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
const igual = (a,b) => crypto.timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));

function autenticar(env) {
  if (![env.DASHCAM_DEVICE_TOKEN,env.DASHCAM_OWNER_TOKEN].every(t => typeof t==='string' && t.length>=32) ||
      !/^[a-z0-9-]{1,80}$/.test(env.DASHCAM_DEVICE_ID||'') || env.DASHCAM_OWNER_TOKEN===env.DASHCAM_DEVICE_TOKEN)
    throw Error('Configura tokens distintos de al menos 32 caracteres y DASHCAM_DEVICE_ID; acceso cerrado');
  return (req,res,next) => {
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    const propietario=igual(token,env.DASHCAM_OWNER_TOKEN);
    const dispositivo=igual(token,env.DASHCAM_DEVICE_TOKEN);
    if (!propietario && !dispositivo) return res.status(401).json({error:'Autenticacion requerida'});
    if (req.method==='GET' && !propietario || req.method!=='GET' && !dispositivo)
      return res.status(403).json({error:'Operacion no permitida para esta credencial'});
    if (req.body?.device_id && req.body.device_id!==env.DASHCAM_DEVICE_ID)
      return res.status(403).json({error:'Dispositivo no autorizado'});
    req.device=env.DASHCAM_DEVICE_ID;
    next();
  };
}

function validarRegistro(r,device) {
  if (!r || !UUID.test(r.id||'') || !UUID.test(r.recorrido_id||'') ||
      !['inicio','fin','muestra','video'].includes(r.tipo) || typeof r.contenido_json!=='string' ||
      Buffer.byteLength(r.contenido_json)>128*1024 || !SHA.test(r.sha256||'') || digest(r.contenido_json)!==r.sha256)
    throw Error('Registro o checksum invalido');
  const contenido=JSON.parse(r.contenido_json);
  if (!contenido || typeof contenido!=='object' || Array.isArray(contenido)) throw Error('Contenido invalido');
  return {id:r.id,device_id:device,recorrido_id:r.recorrido_id,tipo:r.tipo,contenido,contenido_sha256:r.sha256};
}

function montar(app,supabase) {
  const bucket=supabase.storage.from('dashguard-videos');
  const ruta=(device,trip,id)=>`${device}/${trip}/${id}.mp4`;
  app.post('/dashcam/registros',async(req,res)=>{
    try {
      if (!Array.isArray(req.body?.registros) || !req.body.registros.length || req.body.registros.length>100)
        return res.status(400).json({error:'Se requieren entre 1 y 100 registros'});
      let filas;
      try { filas=req.body.registros.map(r=>validarRegistro(r,req.device)); }
      catch { return res.status(400).json({error:'Formato o checksum invalido'}); }
      const confirmados=[];
      for (const fila of filas) {
        const {error}=await supabase.from('dashcam_registros').insert(fila);
        if (error) {
          if (error.code!=='23505') throw error;
          const previo=await supabase.from('dashcam_registros').select('device_id,recorrido_id,tipo,contenido_sha256').eq('id',fila.id).single();
          if (previo.error) throw previo.error;
          if (['device_id','recorrido_id','tipo','contenido_sha256'].some(k=>previo.data[k]!==fila[k]))
            return res.status(409).json({error:'UUID existente con contenido distinto'});
        }
        confirmados.push({id:fila.id,sha256:fila.contenido_sha256,device_id:req.device});
      }
      res.json({confirmados});
    } catch { res.status(502).json({error:'No se confirmaron todos los registros; conservar y reintentar'}); }
  });

  app.put('/dashcam/videos/:trip/:id',express.raw({type:'video/mp4',limit:'8mb'}),async(req,res)=>{
    const {trip,id}=req.params, sha=req.headers['x-content-sha256'];
    if (!UUID.test(trip) || !UUID.test(id) || !SHA.test(sha||'') || !Buffer.isBuffer(req.body) ||
        !req.body.length || digest(req.body)!==sha)
      return res.status(400).json({error:'Video o checksum invalido'});
    try {
      const path=ruta(req.device,trip,id);
      const {error}=await bucket.upload(path,req.body,{contentType:'video/mp4',upsert:false});
      if (error) {
        // Tanto conflicto concurrente como reintento: comprobar bytes existentes.
        const previo=await bucket.download(path);
        if (previo.error) throw previo.error;
        if (digest(Buffer.from(await previo.data.arrayBuffer()))!==sha)
          return res.status(409).json({error:'Video existente con contenido distinto'});
      }
      res.json({video_id:id,recorrido_id:trip,device_id:req.device,sha256:sha,bytes:req.body.length});
    } catch { res.status(502).json({error:'Subida no confirmada; conservar video y reintentar'}); }
  });

  app.get('/dashcam/recorridos',async(req,res)=>{
    try {
      const {data,error}=await supabase.from('dashcam_registros').select('*').eq('device_id',req.device)
        .in('tipo',['inicio','fin']).order('recibido_en',{ascending:false}).limit(500);
      if(error) throw error;
      res.json({registros:data});
    } catch {res.status(502).json({error:'No se pudieron consultar recorridos'});}
  });
  app.get('/dashcam/recorridos/:id',async(req,res)=>{
    if(!UUID.test(req.params.id)) return res.status(400).json({error:'UUID invalido'});
    try {
      const offset=Number(req.query.offset||0);
      if(!Number.isSafeInteger(offset)||offset<0) return res.status(400).json({error:'offset invalido'});
      const {data,error}=await supabase.from('dashcam_registros').select('*').eq('device_id',req.device)
        .eq('recorrido_id',req.params.id).order('id').range(offset,offset+499);
      if(error) throw error;
      res.json({registros:data,siguiente:data.length===500?offset+500:null});
    } catch {res.status(502).json({error:'No se pudo consultar el recorrido'});}
  });
  app.get('/dashcam/videos/:id',async(req,res)=>{
    if(!UUID.test(req.params.id)) return res.status(400).json({error:'UUID invalido'});
    try {
      const r=await supabase.from('dashcam_registros').select('recorrido_id').eq('id',req.params.id)
        .eq('device_id',req.device).eq('tipo','video').single();
      if(r.error) return res.status(404).json({error:'Video no disponible'});
      const {data,error}=await bucket.createSignedUrl(ruta(req.device,r.data.recorrido_id,req.params.id),300);
      if(error) throw error;
      res.json({url:data.signedUrl,expira_s:300});
    } catch {res.status(502).json({error:'No se pudo autorizar reproduccion'});}
  });
}
module.exports={autenticar,validarRegistro,digest,montar};
