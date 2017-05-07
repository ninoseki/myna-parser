'use strict';

/*
    * I need to add memoization, I think this is going to have a huge impact. 
    * To do this, I need to change to "parsers" from "numbers" as results of parsers
    * I notice that "CharSet" could be more efficiently implemented than using "Lookup". Similar, BUT, I need 
*/

let m = require('../myna');
let jg = require('../grammars/grammar_json')(m);
let fs = require('fs');
let input = require('../tests/1k_json.js');

function mergeLookups(r1, r2) {
    let lookup1 = r1.lookup;
    let lookup2 = r2.lookup;
    let lookup = {};
    // Add items from first lookup                     
    for (let k in lookup1) {
        lookup[k] = lookup1[k];
    }
    // Now add items from second lookup 
    for (let k in lookup2) {
        if (k in lookup) 
            lookup[k] = lookup[k].or(lookup2[k]); else 
            lookup[k] = lookup2[k];
    }
    // Add the 'onDefault'
    let onDefault = r1.onDefault;
    if (onDefault !== r2.onDefault) 
        onDefault = onDefault.or(r2.onDefault);                    
    return new m.Lookup(lookup, onDefault);
}

function all(array, fxn) {
    for (let x of array)
        if (!fxn(x))
            return false;
    return true;
}

function convertToLookup(r) {
    if (r instanceof m.Lookup)
        return r;
    if (r instanceof m.Text) 
        return m.char(r.text[0], r.text.slice(1));
    if (r instanceof m.Sequence) {
        let result = convertToLookup(r.rules[0]);
        let tail = new m.Sequence(r.rules.slice(1));
        for (let k in result.lookup)
            result.lookup[k] = optimizeRule(result.lookup[k].then(tail));
        result.onDefault = optimizeRule(result.onDefault.then(tail));
        return result;
    }
    return null;
}

// Tries to convert all rules (assumed to be the child rules of a choice rule)
// into lookups and to merge them. 
function mergeAllToLookup(array) {
    if (array.length == 0)
        return null;
    let result = convertToLookup(array[array.length-1]);
    if (result == null)
        return null;
    for (let i=array.length - 2; i >= 0; --i) {
        let tmp = convertToLookup(array[i]);
        if (tmp == null)
            return null;
        result = mergeLookups(tmp, result)
    }
    return result;
}

// (a b* b) => (a b*)
// (a b+ b) => (b)

function optimizeRule(r) 
{
    if (r instanceof m.Quantified)
    {
        r.rules = r.rules.map(optimizeRule);
    }
    else if (r instanceof m.Sequence)
    {
        let tmp = [];

        for (let i=0; i < r.rules.length; ++i) {
            let r2 = optimizeRule(r.rules[i]);

            // Heuristic: Sequence flattening 
            // (a (b c)) => (a b c)
            if (!r2._createAstNode && r2 instanceof m.Sequence) 
                tmp = tmp.concat(r2.rules); 
            else 
                tmp.push(r2);
        }

        r.rules = tmp;

        if (!r._createAstNode) {
            // Heuristic: zero-length sequence rules are always true 
            // () => true
            if (r.rules.length == 0)
                return m.truePredicate;
           
            // Heuristic: single-length sequence rules are just the child rule
            // (a) => a
            if (r.rules.length == 1)
                return r.rules[0];
        }
    }
    else if (r instanceof m.Choice)
    {
        let tmp = [];

        for (let i=0; i < r.rules.length; ++i) {
            let r2 = optimizeRule(r.rules[i]);
            if (r2 == undefined)
                throw new Error("wtf");

            // Heuristic: Choice flattening
            // (a\(b\c)) => (a\b\c)
            if (!r2._createAstNode && r2 instanceof m.Choice) 
                tmp = tmp.concat(r2.rules);
            else 
                tmp.push(r2);
        }

        // Filter the new list of rules
        for (let i = tmp.length-1; i >= 1; --i) {
            let r1 = tmp[i-1];
            let r2 = tmp[i];
            if (r1._createAstNode || r2._createAstNode) continue;

            // Heuristic: stop processing choice after true
            // (a\true\b) => (a\true)
            if (r1 instanceof m.TruePredicate)
            {
                tmp = tmp.slice(0, i-1);
                continue;
            }

            // Heuristic: remove false nodes 
            // (a\false\b) => (a\b)
            if (r2 instanceof m.FalsePredicate)
            {
                tmp = tmp.splice(i, 1);
                continue;
            }            

            // Heuristic: convert text nodes to lookup tables 
            // This should make lookup merging work better
            // TODO: 

            // Heuristic: merge lookup tables
            let lookup1 = convertToLookup(r1);
            let lookup2 = convertToLookup(r2);
            if (lookup1 && lookup2)
            {
                tmp[i-1] = mergeLookups(lookup1, lookup2);
                tmp.splice(i, 1);
            }
        }

        // TODO: can I convert the things to lookups? 

        r.rules = tmp;

        if (!r._createAstNode) {
            // Heuristic: zero-length choice rules are always true
            if (r.rules.length == 0)
                return m.truePredicate;
            // Heuristic: single-length choice rules are just the child rule
            if (r.rules.length == 1)
                return r.rules[0];
        }
    }
    else if (r instanceof m.Text) 
    {
        if (!r._createAstNode)
        {
            // Heuristic: Text rules with no length are always true
            if (r.text.length == 0)
                return m.truePredicate;

            // Heuristic: Text rules with single length are always one 
            if (r.text.length == 1)
                return m.char(r.text);
        }
    }
    else if (r instanceof m.Not)
    {
        let child = optimizeRule(r.rules[0]);
        
        if (!r._createAstNode) {    
            // Heuristic: 
            // Not(Not(X)) => X
            if (child instanceof m.Not)
                return child.rules[0];

            // Heuristic: 
            // Not(At(X)) => Not(X)
            if (child instanceof m.At)
                return child.rules[0].not;

            // Heuristic: 
            // Not(True) => False
            if (child instanceof m.TruePredicate)
                return m.falsePredicate;

            // Heuristic: 
            // Not(False) => True
            if (child instanceof m.FalsePredicate)
                return m.truePredicate;

            // Heuristic:
            // Not([abc]) => [^abc];
            if (child instanceof CharSet)
                return m.notAtChar(child.chars);

            // Heuristic:
            // Not([^abc]) => [abc];
            if (child instanceof NegatedCharSet)
                return m.char(child.chars);

            // Not(Advance) => AtEnd
            if (child instanceof Advance) 
                return m.atEnd;
        }

        // Set the child to be the new optimized rule 
        r.rules[0] = child;
        return r;                
    }
    else if (r instanceof m.At)
    {
        let child = optimizeRule(r.rules[0]);
        
        if (!r._createAstNode) {    
            // Heuristic: 
            // At(At(X)) => At(X)
            if (child instanceof m.At)
                return child;

            // Heuristic: 
            // At(Not(X)) => Not(X)
            if (child instanceof m.Not)
                return child;

            // Heuristic: 
            // At(<predicate>) => <predicate>
            if (child instanceof m.MatchRule)
                return child;

            // Heuristic:
            // At([abc]) => <lookup>;
            if (child instanceof CharSet)
                return new m.Lookup(child.lookup, m.truePredicate);

            // Heuristic:
            // At([^abc]) => <lookup>;
            if (child instanceof NegatedCharSet)
                return child;
        }

        // Set the child to be the new optimized rule 
        r.rules[0] = child;
        return r;                
    }

    return r;
}

function timeIt(fn) {
    let start = process.hrtime();
    fn();
    let end = process.hrtime();
    let precision = 3; // 3 decimal places
    let elapsed = process.hrtime(start)[1] / 1000000; // divide by a million to get nano to milli
    console.log(process.hrtime(start)[0] + " s, " + elapsed.toFixed(precision) + " ms"); 
}

function timeParse(rule, input) {
    timeIt(function () { 
        for (let i=0; i < 1; ++i)
            m.parse(rule, input); 
    });    
}

let o = jg.array;
let o2 = optimizeRule(o.copy);

{
    let rs = m.ruleStructure(o); 
    let txt = JSON.stringify(rs, null, 2);
    //console.log(txt);
    fs.writeFileSync("e:\\tmp\\myna.json", txt);
}
{
    let rs = m.ruleStructure(o2); 
    let txt = JSON.stringify(rs, null, 2);
    //console.log(txt);
    fs.writeFileSync("e:\\tmp\\myna_opt.json", txt);
}

let ast = m.parse(o, input);
let ast2 = m.parse(o2, input);

// TODO: compre the two ASTs. I need a function for converting an AST to a string. 

timeParse(o, input);
timeParse(o2, input);


// console.log(r);
process.exit();