"use strict";

function forall(obj, f) {
  if (obj.constructor === Array) {
    for (var i = 0; i < obj.length; i++) {
      var ret = f(obj[i]);
      if (ret !== undefined) {
        return ret;
      }
    }
  } else {
    var keys = Object.keys(obj).sort();
    for (var i = 0; i < keys.length; i++) {
      var ret = f(obj[keys[i]], keys[i]);
      if (ret !== undefined) {
        return ret;
      }
    }
  }
}

var Checks = (function() {
  var registry = {
    "index.settings" : [],
    "index.segments" : [],
    "index.mappings" : [],
    "index.flat_mappings" : [],
    "index.mappings.fields" : []
  };

  function register(phase, checks) {
    for (var i = 0; i < checks.length; i++) {
      registry[phase].push(checks[i])
    }
    return Checks;
  }

  function checks_for_phase(phase) {
    return registry[phase];
  }

  function get_key(o, path) {
    var keys = path.split('.');
    while (keys.length) {
      if (!o instanceof Object) {
        return "";
      }
      var key = keys.shift();
      if (o.hasOwnProperty(key)) {
        o = o[key]
      } else {
        return "";
      }
    }

    return o == undefined ? "" : o;
  }

  function check_types(msg, mappings, f) {
    var errors = [];
    for ( var type in mappings) {
      if (f(type)) {
        errors.push("`" + type + "`");
      }
    }
    if (errors.length) {
      return msg + ", in type" + (errors.length > 1 ? 's: ' : ': ')
        + errors.join(", ");
    }
  }

  return {
    check_types : check_types,
    checks_for_phase : checks_for_phase,
    get_key : get_key,
    register : register,
    registry : registry
  };

})();

function Checker(host, out_id) {

  var version;
  var es_data;
  var log;

  function run() {
    log = new Logger(out_id);
    log.log('Checking cluster at: ' + host);

    check_version() //
    .then(load_es_data) //
    .then(function() {
      return Promise.attempt(check_indices)
    }) //
    .then(finish) //
    .caught(log.error);
  }

  function finish() {
    log.log('Done');
  }

  function check_indices() {
    var indices = Object.keys(es_data.index.aliases).sort();
    if (indices.length == 0) {
      log.log("No indices found");
      return;
    }

    forall(indices, function(index) {
      var index_color = 'green';
      log.start_section('Index: ' + index);

      /* index.* */
      forall([ 'index.segments', 'index.settings', 'index.mappings',
        'index.flat_mappings' ], function(phase) {

        var data = data_for_phase(phase, index);
        if (data) {
          var checks = Checks.checks_for_phase(phase);
          var color = run_checks(checks, data, index);
          index_color = worse_color(index_color, color);
        }
      });

      /* index.mappings.fields */
      var mappings = Checks.get_key(es_data, 'index.flat_mappings.' + index);
      if (mappings) {
        var checks = Checks.checks_for_phase('index.mappings.fields');
        forall(checks, function(check) {
          var color = check_fields(check, mappings);
          index_color = worse_color(index_color, color);
        });
      }
      log.set_section_color(index_color);
      log.end_section();
    });
  }

  function check_fields(check, mappings) {
    var errors = [];
    forall(mappings, function(type) {
      if ("properties" in type) {
        forall(type.properties, function(field) {
          var msg = check.check(field);
          if (msg) {
            errors.push(msg)
          }
        })
      }
    });

    var color = errors.length ? check.color : 'green';
    log.result(color, check.name, errors.join("\n"));
    return color;
  }

  function run_checks(checks, data, name) {
    var phase_color = 'green';
    forall(checks, function(check) {
      var msg = check.check(data, name);
      var color = 'green';
      if (msg) {
        color = check.color;
        phase_color = worse_color(phase_color, color);
      }
      log.result(color, check.name, msg);
    });
    return phase_color;
  }

  function data_for_phase(phase, name) {
    var data = Checks.get_key(es_data, phase + '.' + name);
    if (data == "") {
      return false
    }

    var sub = phase.substr(6);
    if (sub in data) {
      return data[sub];
    }
    return data;
  }

  function load_es_data() {
    return Promise.all([ //
    get_url('/_segments'), //
    get_url('/_settings'), //
    get_url('/_mappings'), //
    get_url('/_warmers'), //
    get_url('/_aliases'), //
    get_url('/_cluster/settings') //
    ]).//
    then(function(data) {
      es_data = {
        index : {
          segments : data[0].indices,
          settings : data[1],
          mappings : data[2],
          flat_mappings : flatten_mappings(data[2]),
          warmers : data[3],
          aliases : data[4]
        },
        cluster : {
          settings : data[5]
        }
      };
    });
  }

  function flatten_mappings(mappings) {
    var flat = {};

    function flatten_type(type_name, type) {
      var fields = {};

      function flatten_fields(prefix, d) {
        for ( var field_name in d) {
          var field = d[field_name];
          var path = prefix + field_name;

          if ("properties" in field) {
            flatten_fields(path + ".", field.properties);
            delete field.properties;
          }
          if ("fields" in field) {
            flatten_fields(path + ".", field.fields);
            delete field.fields;
          }
          field._name = type_name + ":" + path;
          fields[path] = field;
        }
      }

      var properties = type.properties;
      delete type.properties;
      var flat_type = type;
      flatten_fields('', properties);
      flat_type.properties = fields;
      return flat_type;

    }

    for ( var index_name in mappings) {
      var index = mappings[index_name].mappings;
      flat[index_name] = {};
      for ( var type in index) {
        flat[index_name][type] = flatten_type(type, index[type]);
      }
    }

    return flat;
  }

  function check_version() {
    return get_url('/').then(
      function(r) {
        var parts = r.version.number.split('.');
        var snapshot = Checks.get_key(r, "version.build_snapshot");
        version = {
          major : parts[0],
          minor : parts[1],
          patch : parts[2],
          snapshot : snapshot
        };
        log.result('green', "Elasticsearch version: " + r.version.number
          + (snapshot ? '.SNAPSHOT' : ''));
        // TODO: Throw exception if wrong version
      });
  }

  function then_in_turn(list, func) {
    return (function next() {
      if (list.length) {
        return Promise.attempt(func, [ list.shift() ]).then(next);
      }
    }());
  }

  function worse_color(current_color, new_color) {
    if (current_color == 'red' || new_color == 'red') {
      return 'red'
    }
    if (current_color == 'yellow' || new_color == 'yellow') {
      return 'yellow'
    }
    if (current_color == 'blue' || new_color == 'blue') {
      return 'blue'
    }
    return 'green';
  }

  function get_url(path, params) {
    return new Promise(function(resolve, reject) {
      jQuery.getJSON(host + path, params).done(resolve).fail(function(e) {
        var msg = "Failed to fetch [" + host + path;
        if (params) {
          msg += '?' + jQuery.param(params);
        }
        msg += '].  REASON: ';
        if (e.responseJSON && ("error" in e.responseJSON)) {
          msg += e.responseJSON.error;
        } else if (e.responseText) {
          msg += e.responseText;
        } else {
          msg += e.statusText;
        }
        reject(msg);
      });
    });
  }

  function Logger(out_id) {
    var out;
    var sections = [];

    jQuery(out_id).html('<ul id="output"></ul>');
    out = jQuery('#output');

    function start_section(msg) {
      out.append('<li><span class="section msg">' + msg
        + '</span><ul></ul></li>');
      sections.push(out);
      out = out.find(':last');
    }

    function set_section_color(color) {
      out.parent().addClass(color)
    }

    function end_section() {
      out = sections.pop();
    }

    function log(msg) {
      out.append('<li>' + msg + '</li>');
    }

    function error(e) {
      console.log(e.message, e.stack);
      while (sections.length) {
        end_section()
      }
      out.append('<p class="error">' + e.message + '</p>');
    }

    function result(color, check, msg) {
      check = check.replace(/`([^`]+)`/g, "<code>$1</code>");
      if (msg) {
        start_section(check);
        msg = msg.replace(/`([^`]+)`/g, "<code>$1</code>");
        forall(msg.split(/\n/), function(line) {
          result(color, line);
        });
        set_section_color(color);
        end_section();
      } else {
        out.append('<li class="' + color + '"><span class="check">' + check
          + '</span></li>');
      }
    }

    return {
      log : log,
      error : error,
      result : result,
      start_section : start_section,
      end_section : end_section,
      set_section_color : set_section_color
    };

  }

  return {
    run : run
  }
};

