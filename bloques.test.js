const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {agrupar,contarFrames,uuid}=require('./bloques');
test('reagrupa MP4 sin perder fotogramas, conserva fuentes y no sobrescribe',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dashguard-test-'));
 try{
  const fuente=path.join(dir,'fuente.mp4'),salida=path.join(dir,'salida');await fs.mkdir(salida);
  execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','color=c=black:s=160x120:r=15','-t','12','-c:v','libx264','-g','15','-pix_fmt','yuv420p',fuente],{windowsHide:true});
  const antes=await fs.readFile(fuente),grupos=await agrupar([fuente],salida,2);
  assert.equal(grupos.length,6);assert.equal(grupos.reduce((n,g)=>n+g.frames,0),180);
  assert.equal(await contarFrames(fuente),180);assert.deepEqual(await fs.readFile(fuente),antes);
  await assert.rejects(agrupar([fuente],salida,2));
  assert.equal(uuid('mismo bloque'),uuid('mismo bloque'));
  assert.notEqual(uuid('mismo bloque'),uuid('otro bloque'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
