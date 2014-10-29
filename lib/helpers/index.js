var helpers = {};
var namespace = null;
var moment = require('moment-timezone');
var _ = require('underscore');
_.mixin(require('underscore.nested'));
var url = require('url');
var handlebars = require('handlebars');

helpers.compare = function(lvalue, rvalue, options) {
  if (arguments.length < 3) {
    var err = "Handlerbars Helper 'compare' needs 2 parameters";
    console.log(err);
    throw new Error(err);
  }
  operator = options.hash.operator || "==";

  var operators = {
    '==':       function(l,r) { return l == r; },
    '===':      function(l,r) { return l === r; },
    '!=':       function(l,r) { return l != r; },
    '<':        function(l,r) { return l < r; },
    '>':        function(l,r) { return l > r; },
    '<=':       function(l,r) { return l <= r; },
    '>=':       function(l,r) { return l >= r; },
    'typeof':   function(l,r) { return typeof l == r; }
  }

  if (!operators[operator]) {
    throw new Error("Handlerbars Helper 'compare' doesn't know the operator "+operator);
  }

  var result = operators[operator](lvalue,rvalue);

  if( result ) {
    return options.fn(this);
  } else {
    return options.inverse(this);
  }
};

helpers.collections_pager = function(view, req, res) {


  return function (context, options) {
    var q = this.locals.req;
    if(!this.locals.req) return "Error: this.locals.req";
    var u = url.parse(this.locals.req.url);

    var total = this.total;   //total number of items (in collection)
    if(!total) return;
    var from = this.from;
    var limit = this.size;
    var pageParam = 'page';
    var num_pages = Math.ceil(total/limit); //calculate number of pages
    if(num_pages < 2) return;               //no need for a pager

    var next = 1;

    var page = 0, args = {};
    if(this.locals.req.query) {
      page = parseInt(this.locals.req.query.page) || 0;
      args = _.clone(this.locals.req.query);
      next = page + 1;
    }

    u.search = null;

    var data = {
      'first': { 'title': 'First', 'class': 'disabled' },
      'previous': { 'title': 'Previous', 'class': 'disabled' },
      'next': { 'title': 'Next', 'class': 'disabled' },
      'last': { 'title': 'Last', 'class': 'disabled' }
    };

    //next & last pager
    if((num_pages - next) >= 1) {
      args[pageParam] = next;
      u.query = args;
      data.next.class = data.last.class = '';
      data.next.href = url.format(u);
      args[pageParam] = num_pages - 1;
      u.query = args;
      data.last.href = url.format(u);
    }
    //first & prev pager
    if(page > 0) {
      var previous = (page - 1);
      data.first.class = data.previous.class = '';
      if(previous) {
        args[pageParam] = previous;
      } else {
        delete args[pageParam];
      }
      u.query = args;
      data.previous.href = url.format(u);
    }

    var firstPage = 0;
    if(num_pages > 9 && page > 1) {
      firstPage = Math.min(page - 1, (num_pages - 9));
    }
    var lastPage = (num_pages > 9) ? firstPage + 10 : num_pages; //(num_pages > 9 && page > 0) ? Math.min((page + 9), num_pages) : num_pages;

    data.items = [];
    for(var i=firstPage;i<lastPage;i++) {
      if(!i) {
        u.query = _.clone(args);
        delete u.query[pageParam];
      } else {
        args[pageParam] = i;
        u.query = args;
      }
      var item = {
        title: (i + 1),
        href: url.format(u),
        class: (i == page) ? 'disabled':'active'
      }
      data.items.push(item);
    }
    return view.partial(this.locals, 'pagination', data);
  }
}

helpers.baseUrl = function baseUrl(view, req, res) {
  return function() {
    return url.parse(req.originalUrl).pathname;
  }
}

helpers.foreach = function(view, req, res) {
  return function (context, options) {

    var fn = options.fn,
      inverse = options.inverse,
      i = 0,
      j = 0,
      columns = options.hash.columns,
      group = options.hash.group,
      groupby = options.hash.groupby,
      currentgroup = null,
      key,
      ret = "",
      data;

    if (options.data) {
      data = handlebars.createFrame(options.data);
    }

    function setKeys(_data, _i, _j, _columns) {
      _data.group = false;
      _data.groupEnd = false;
      if (_i === 0) {
        _data.first = true;
        if(group && groupby) {
          if(context[0][groupby]) {
            if(group == 'A-Z') {
              currentgroup = String(context[0][groupby]).charAt(0);
            }
            _data.group = currentgroup;
            _data.rowStart = true;
          }
        }
      } else {
        if(group && groupby) {
          if(context[_i][groupby]) {
            if(group == 'A-Z') {
              cur = String(context[_i][groupby]).charAt(0);
            }
            if(cur !== currentgroup) {
              currentgroup = cur;
              _data.group = currentgroup;
              _data.rowStart = true;
              _data.groupEnd = true;
            }
          }
        }
      }

      if (_i === _j - 1) {
        _data.last = true;
        _data.groupEnd = true;
      }
      // first post is index zero but still needs to be odd
      if (_i % 2 === 1) {
        _data.even = true;
        _data.evenClass = 'even';
        _data.oddClass = '';
      } else {
        _data.odd = true;
        _data.oddClass = 'odd';
        _data.evenClass = '';
      }
      if (_i % _columns === 0) {
        _data.rowStart = true;
      } else if (_i % _columns === (_columns - 1)) {
        _data.rowEnd = true;
      }
      return _data;
    }
    if (context && typeof context === 'object') {
      if (context instanceof Array) {
        for (j = context.length; i < j; i += 1) {
          if (data) {
            data.index = i;
            data.first = data.rowEnd = data.rowStart = data.last = data.even = data.odd = false;
            data = setKeys(data, i, j, columns);
          }
          ret = ret + fn(context[i], { data: data });
        }
      } else {
        for (key in context) {
          if (context.hasOwnProperty(key)) {
            j += 1;
          }
        }
        for (key in context) {
          if (context.hasOwnProperty(key)) {
            if (data) {
              data.key = key;
              data.first = data.rowEnd = data.rowStart = data.last = data.even = data.odd = false;
              data = setKeys(data, i, j, columns);
            }
            ret = ret + fn(context[key], {data: data});
            i += 1;
          }
        }
      }
    }

    if (i === 0) {
      ret = inverse(this);
    }
    return ret;
  };
}

helpers.moment_date = function(view, req, res) {
  return function (date, format) {
    return moment(date).format(format);
  }
}

helpers.moment_daterange_timezone = function(view, req, res) {
  return function (context, timezone) {
    var result = '';
    if(context.date.from && context.date.to) {
      var tz = context.timezone || 'Europe/Moscow';
      var from = moment.tz(context.date.from, tz);
      var to = moment.tz(context.date.to, tz);

      if(from.isSame(to, 'day')) {
        result += '<span class="date">';
        result += from.format('MMM, Do YYYY');
        result += ' from ';
        result += from.format('HH:mm');
        result += ' to ';
        result += to.format('HH:mm');
        if(tz) {
          result += ' ('+tz+')';
        }
        result += '</span>';
      } else {
        result += '<span class="date">';
        result += from.format('MMM, Do YYYY - HH:mm');
        result += ' to ';
        result += to.format('MMM, Do YYYY - HH:mm');
        if(tz) {
          result += ' ('+tz+')';
        }
        result += '</span>';

      }
    }
    return new handlebars.SafeString(result);
  }
}

helpers.link = function(view, req, res) {

  return function(context, options) {
    if(req.locale == 'ru') {
      return '/ru' + this.url;
    } else {
      return this.url;
    }
  }
}

helpers.statics = function(view, req, res) {

  return function(context) {
    var config = res.locals._view.theme.config;
    if(config.statics) {
      if(config.cdn && config.cdn.enabled) {
        if(config.cdn.base_url) {
          return config.cdn.base_url;
        }
      }
      return config.statics;
    }
  }
}

helpers.has = function(context, params, options) {
  if(arguments.length == 3) {
    context = context || {};
    options = options || {};
  } else if(arguments.length == 2) {
    options = params;
    params = context;
    context = this;
  }

  if (!_.isString(params)) {
    console.log('Invalid or no attribute given to is helper');
    return;
  }

  function evaluateContext(expr) {
    return expr.split(',').map(function (v) {
        return v.trim();
    }).reduce(function (p, c) {
        return p || _.getNested(context, c);
    }, false);
  }

  if (evaluateContext(params)) {
    return options.fn(this);
  }
  return options.inverse(this);
}

registerViewHelpers = function(view) {

  //register "simple" helpers
  view.registerHelper('compare', helpers.compare);
  view.registerRequestHelper('theme:statics', helpers.statics);

  //register helpers with context information, e.g. theme.
  view.registerRequestHelper('foreach', helpers.foreach);
  view.registerRequestHelper('collection:pager', helpers.collections_pager);

  view.registerRequestHelper('moment:date', helpers.moment_date);
  view.registerRequestHelper('moment:daterange:timezone', helpers.moment_daterange_timezone);
  view.registerRequestHelper('url:item', helpers.link);
  view.registerRequestHelper('url:baseurl', helpers.baseUrl);

  view.registerHelper('has', helpers.has);
}

module.exports = helpers;
module.exports.registerViewHelpers = registerViewHelpers;
