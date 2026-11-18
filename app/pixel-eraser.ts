import { b64Vecs, Box, createShapeId, getPointsFromDrawSegments, StateNode, type Editor, type TLDrawShape, type TLHighlightShape, type VecModel } from 'tldraw'

type Stroke = TLDrawShape | TLHighlightShape
type Point = { x:number; y:number }

function distanceToSegment(point:Point, a:Point, b:Point) {
 const dx=b.x-a.x,dy=b.y-a.y, length=dx*dx+dy*dy
 const t=length ? Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)) : 0
 return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy)
}

/** Split a freehand stroke into the portions outside the eraser path. */
function splitStroke(editor:Editor,shape:Stroke,path:Point[],radius:number):VecModel[][]|null {
 const transform=editor.getShapePageTransform(shape)
 if(!transform)return null
 const points=getPointsFromDrawSegments(shape.props.segments)
 if(!points.length)return null
 const pagePoint=(p:VecModel)=>transform.applyToPoint({x:p.x*shape.props.scaleX,y:p.y*shape.props.scaleY})
 const erased=(p:VecModel)=>{
  const point=pagePoint(p)
  if(path.length===1)return Math.hypot(point.x-path[0].x,point.y-path[0].y)<=radius
  return path.some((end,i)=>i>0&&distanceToSegment(point,path[i-1],end)<=radius)
 }
 const runs:VecModel[][]=[]
 let run:VecModel[]=[],hit=false
 const push=(p:VecModel)=>{if(erased(p)){hit=true;if(run.length>1)runs.push(run);run=[]}else run.push(p)}
 push(points[0])
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i],pa=pagePoint(a),pb=pagePoint(b)
  const steps=Math.max(1,Math.ceil(Math.hypot(pb.x-pa.x,pb.y-pa.y)/Math.max(radius/2,0.5)))
  for(let n=1;n<=steps;n++){const t=n/steps;push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t})}
 }
 if(run.length>1)runs.push(run)
 return hit?runs:null
}

/** Removes portions of pen and highlighter strokes; other shapes remain intact. */
export class PixelEraser extends StateNode {
 static override id='pixel-eraser'
 static override isLockable=false
 private path:Point[]|null=null
 override onEnter(){this.editor.setCursor({type:'cross',rotation:0})}
 override onPointerDown(){const p=this.editor.inputs.getCurrentPagePoint();this.path=[{x:p.x,y:p.y}]}
 override onPointerMove(){if(!this.path)return;const p=this.editor.inputs.getCurrentPagePoint(),last=this.path[this.path.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)>=3/this.editor.getZoomLevel())this.path.push({x:p.x,y:p.y})}
 override onPointerUp(){
  if(!this.path)return
  const p=this.editor.inputs.getCurrentPagePoint();this.path.push({x:p.x,y:p.y})
  const path=this.path;this.path=null
  const editor=this.editor,radius=12/editor.getZoomLevel()
  const candidates=editor.getShapeIdsInsideBounds(Box.FromPoints(path).expandBy(radius))
  const changes:{shape:Stroke;runs:VecModel[][]}[]=[]
  for(const id of candidates){
   const shape=editor.getShape(id)
   if(!shape||(shape.type!=='draw'&&shape.type!=='highlight')||editor.isShapeOrAncestorLocked(shape))continue
   const runs=splitStroke(editor,shape,path,radius)
   if(runs)changes.push({shape,runs})
  }
  if(!changes.length)return
  editor.markHistoryStoppingPoint('partial erase')
  editor.run(()=>{
   for(const {shape,runs} of changes){
    if(!runs.length){editor.deleteShape(shape.id);continue}
    const propsFor=(run:VecModel[])=>({...shape.props,segments:[{type:'free' as const,path:b64Vecs.encodePoints(run)}],isComplete:true,...(shape.type==='draw'?{isClosed:false,fill:'none' as const}:{})})
    editor.updateShape({id:shape.id,type:shape.type,props:propsFor(runs[0])})
    for(const run of runs.slice(1))editor.createShape({id:createShapeId(),type:shape.type,parentId:shape.parentId,x:shape.x,y:shape.y,rotation:shape.rotation,opacity:shape.opacity,props:propsFor(run)})
   }
  })
 }
 override onCancel(){this.path=null}
 override onExit(){this.path=null}
}
