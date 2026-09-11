export type PhotoCropEdit={rotation:0|90|180|270;zoom:number;offsetX:number;offsetY:number;straighten?:number;cropWidth?:number;cropHeight?:number};
export type PhotoSize={width:number;height:number};
const bounded=(v:unknown,f:number,min:number,max:number)=>Math.min(max,Math.max(min,Number.isFinite(Number(v))?Number(v):f));
export function photoCropDimensions(edit:PhotoCropEdit):PhotoSize{
 const w=bounded(edit.cropWidth,2,.01,10000),h=bounded(edit.cropHeight,3,.01,10000),factor=Math.min(600/w,900/h);
 return {width:Math.max(1,Math.round(w*factor)),height:Math.max(1,Math.round(h*factor))};
}
export function photoCropTransform(source:PhotoSize,frame:PhotoSize,edit:PhotoCropEdit){
 if([source.width,source.height,frame.width,frame.height].some(v=>!Number.isFinite(v)||v<=0))throw Error('Некоректний розмір фото.');
 const quarter=[0,90,180,270].includes(edit.rotation)?edit.rotation:0,angle=bounded(edit.straighten,0,-45,45)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),turn=quarter===90||quarter===270;
 const sw=turn?source.height:source.width,sh=turn?source.width:source.height,rw=Math.abs(cos)*frame.width+Math.abs(sin)*frame.height,rh=Math.abs(sin)*frame.width+Math.abs(cos)*frame.height;
 const scale=Math.max(rw/sw,rh/sh)*bounded(edit.zoom,1,1,2.5),px=bounded(edit.offsetX,0,-1,1)*Math.max(0,(sw*scale-rw)/2),py=bounded(edit.offsetY,0,-1,1)*Math.max(0,(sh*scale-rh)/2);
 return {centerX:frame.width/2+cos*px-sin*py,centerY:frame.height/2+sin*px+cos*py,rotationRadians:quarter*Math.PI/180+angle,drawWidth:source.width*scale,drawHeight:source.height*scale};
}
