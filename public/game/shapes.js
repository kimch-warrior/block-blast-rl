// Rendering geometry recovered from the supplied build; no game code is executed.
const definitions = [{"id":1,"matrix":[[1]]},{"id":2,"matrix":[[1],[1]]},{"id":3,"matrix":[[1,1]]},{"id":4,"matrix":[[1],[1],[1]]},{"id":5,"matrix":[[1,1,1]]},{"id":6,"matrix":[[1,1],[1,0]]},{"id":7,"matrix":[[1],[1],[1],[1]]},{"id":8,"matrix":[[1,0,0],[1,1,1]]},{"id":9,"matrix":[[1,1],[1,1]]},{"id":10,"matrix":[[0,1,0],[1,1,1]]},{"id":11,"matrix":[[1,1,1,1,1]]},{"id":12,"matrix":[[1,1,1],[0,0,1],[0,0,1]]},{"id":13,"matrix":[[1,1,1],[1,1,1],[1,1,1]]},{"id":14,"matrix":[[0,1,1],[1,1,0]]},{"id":15,"matrix":[[1,1],[0,1]]},{"id":16,"matrix":[[1,0],[1,1],[0,1]]},{"id":17,"matrix":[[1,1,1,1]]},{"id":18,"matrix":[[1,1,0],[0,1,1]]},{"id":19,"matrix":[[0,1],[1,1],[1,0]]},{"id":20,"matrix":[[1,0],[1,1],[1,0]]},{"id":21,"matrix":[[1,1,1],[1,0,0],[1,0,0]]},{"id":22,"matrix":[[1],[1],[1],[1],[1]]},{"id":23,"matrix":[[1,0,0],[1,0,0],[1,1,1]]},{"id":24,"matrix":[[0,0,1],[0,0,1],[1,1,1]]},{"id":25,"matrix":[[0,1],[1,1],[0,1]]},{"id":26,"matrix":[[1,1,1],[0,1,0]]},{"id":27,"matrix":[[1,0],[1,1]]},{"id":28,"matrix":[[0,1],[1,1]]},{"id":29,"matrix":[[0,1],[0,1],[1,1]]},{"id":30,"matrix":[[1,1,1],[0,0,1]]},{"id":31,"matrix":[[1,1],[1,0],[1,0]]},{"id":32,"matrix":[[1,1],[0,1],[0,1]]},{"id":33,"matrix":[[0,0,1],[1,1,1]]},{"id":34,"matrix":[[1,1,1],[1,0,0]]},{"id":35,"matrix":[[1,1,1],[1,1,1]]},{"id":36,"matrix":[[1,1],[1,1],[1,1]]},{"id":37,"matrix":[[1,0],[0,1]]},{"id":38,"matrix":[[0,1],[1,0]]},{"id":39,"matrix":[[1,0,0],[0,1,0],[0,0,1]]},{"id":40,"matrix":[[0,0,1],[0,1,0],[1,0,0]]},{"id":41,"matrix":[[0,0,1],[0,1,0],[1,0,0]]},{"id":42,"matrix":[[1,0],[1,0],[1,1]]},{"id":43,"matrix":[[1,0,0],[1,1,1],[1,0,0]]},{"id":44,"matrix":[[1,0,1],[1,1,1]]},{"id":45,"matrix":[[1,1],[0,1],[1,1]]},{"id":46,"matrix":[[1,1,1],[1,0,1]]},{"id":47,"matrix":[[1,1],[1,0],[1,1]]},{"id":48,"matrix":[[0,1,0],[0,1,0],[1,1,1]]},{"id":49,"matrix":[[0,0,1],[1,1,1],[0,0,1]]},{"id":50,"matrix":[[1,1,1],[0,1,0],[0,1,0]]},{"id":51,"matrix":[[0,1,0],[1,1,1],[0,1,0]]}];

export const SHAPES = definitions.map(({ id, matrix }) => {
  const height = matrix.length;
  const width = matrix[0].length;
  const cells = matrix.flatMap((row, y) => row.flatMap((filled, x) => filled ? [{ x, y }] : []));
  const rowMasks = matrix.map(row => row.reduce((mask, cell) => (mask << 1) | cell, 0));
  return Object.freeze({ id, matrix, width, height, cells, rowMasks });
});

const byId = new Map(SHAPES.map(shape => [shape.id, shape]));
export const getShape = id => byId.get(id) ?? null;
