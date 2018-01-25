// eslint-disable-next-line no-unused-vars
module.exports = function(req, res) {
  return { 'test|10': [{ id: '@integer()', city: '@city(true)' }] }
}
