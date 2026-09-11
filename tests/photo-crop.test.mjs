import test from "node:test";
import assert from "node:assert/strict";
import {photoCropDimensions,photoCropTransform} from "../lib/photo-crop-transform.ts";
test("crop geometry keeps every corner inside the photo at all rotations and extreme pans",()=>{
 const base={rotation:0,zoom:1,offsetX:0,offsetY:0};assert.deepEqual(photoCropDimensions(base),{width:600,height:900});
 for(const source of [{width:1200,height:800},{width:800,height:1200},{width:500,height:500}])for(const rotation of [0,90,180,270])for(const straighten of [-45,-10,0,17,45])for(const cropWidth of [1,2,4])for(const cropHeight of [1,3,5])for(const zoom of [1,2.5])for(const offsetX of [-1,0,1])for(const offsetY of [-1,0,1]){
 const edit={rotation,straighten,cropWidth,cropHeight,zoom,offsetX,offsetY},frame=photoCropDimensions(edit),t=photoCropTransform(source,frame,edit),cos=Math.cos(-t.rotationRadians),sin=Math.sin(-t.rotationRadians);
 for(const x of [0,frame.width])for(const y of [0,frame.height]){const dx=x-t.centerX,dy=y-t.centerY;assert.ok(Math.abs(cos*dx-sin*dy)<=t.drawWidth/2+1e-7);assert.ok(Math.abs(sin*dx+cos*dy)<=t.drawHeight/2+1e-7);}
 }
});

