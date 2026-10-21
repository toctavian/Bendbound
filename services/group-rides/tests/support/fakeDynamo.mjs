import assert from 'node:assert/strict';
/** Small expression contract fake. Actual transaction expressions are also tested
 * against DynamoDB Local; this is not a substitute for that service. */
export function store() {
  const items = new Map(), inputs = [];
  const copy = (value) => value === undefined ? undefined : structuredClone(value);
  const conditional = () => Object.assign(new Error('conditional'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  function matches(input, item) {
    if (!input.ConditionExpression) return true;
    const tokens = input.ConditionExpression.match(/attribute_not_exists|[#:A-Za-z0-9_.]+|[()=<>]/g); let offset = 0;
    const value = (token) => token.startsWith(':') ? input.ExpressionAttributeValues[token] : item?.[input.ExpressionAttributeNames?.[token] ?? token];
    function term() {
      const token = tokens[offset++];
      if (token === '(') { const result = expression(); assert.equal(tokens[offset++], ')'); return result; }
      if (token === 'attribute_not_exists') { assert.equal(tokens[offset++], '('); const result = value(tokens[offset++]) === undefined; assert.equal(tokens[offset++], ')'); return result; }
      const left = value(token), op = tokens[offset++], right = value(tokens[offset++]);
      if (op === '=') return left === right; if (op === '>') return left > right; throw new Error('Unsupported predicate');
    }
    function conjunction() { let result = term(); while (tokens[offset] === 'AND') { offset++; const next = term(); result = result && next; } return result; }
    function expression() { let result = conjunction(); while (tokens[offset] === 'OR') { offset++; const next = conjunction(); result = result || next; } return result; }
    const result = expression(); assert.equal(offset, tokens.length); return result;
  }
  function apply(input) {
    if (input.Item) { items.set(input.Item.pk, copy(input.Item)); return; }
    const old = { ...items.get(input.Key.pk), ...input.Key };
    for (const pair of input.UpdateExpression.replace(/^SET /, '').split(',')) {
      const [field, token] = pair.trim().split(/\s*=\s*/);
      old[input.ExpressionAttributeNames?.[field] ?? field] = input.ExpressionAttributeValues[token];
    }
    items.set(input.Key.pk, old);
  }
  return { items, inputs, client: { async send(command) {
    const input = command.input; inputs.push(input);
    if (command.constructor.name === 'GetCommand') { assert.equal(input.ConsistentRead, true); return { Item: copy(items.get(input.Key.pk)) }; }
    if (command.constructor.name === 'TransactWriteCommand') {
      for (const entry of input.TransactItems) { const p = Object.values(entry)[0]; if (!matches(p, items.get((p.Key ?? p.Item).pk))) throw conditional(); }
      for (const entry of input.TransactItems) if (!entry.ConditionCheck) apply(Object.values(entry)[0]);
      return {};
    }
    if (['UpdateCommand', 'PutCommand'].includes(command.constructor.name)) {
      if (!matches(input, items.get((input.Key ?? input.Item).pk))) throw conditional();
      apply(input); return {};
    }
    throw new Error('Unsupported fake command');
  } } };
}
